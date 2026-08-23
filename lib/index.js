// dsh-bg-image — host half.
// Registers the `bg-image` settings namespace for persistence (settings.yaml)
// and serves the config + image over the plugin's own HTTP surface, because the
// wire `settings.describe` allowlist is closed to third-party namespaces.
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { extname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The bundled gradient shipped with the plugin; an empty imagePath means "use this". */
const DEFAULT_IMAGE_PATH = fileURLToPath(new URL("../assets/default-bg.png", import.meta.url));

/** Steam app id of Wallpaper Engine; its workshop content lives under this id. */
const WALLPAPER_ENGINE_APP_ID = "431960";

const SETTINGS_NAMESPACE = settingsNamespace("bg-image");

/** Durable settings schema; the browser scope validates the same envelope. */
const BgSettingsSchema = z.object({
	enabled: z.boolean().default(false),
	imagePath: z.string().default(""),
	opacity: z.number().min(0).max(0.9).step(0.05).default(0.35),
	sidebarTransparent: z.boolean().default(true),
	workshopPath: z.string().default(""),
	hiddenIds: z.array(z.string()).default([]),
	extraIds: z.array(z.string()).default([]),
	galleryMode: z.union(["curated", "all"]).default("curated")
});

/** 从任意输入整理出合法的工坊 id 列表。 */
function sanitizeIdList(value, fallback = []) {
	const source = Array.isArray(value) ? value : fallback;
	return [...new Set(source.filter((id) => typeof id === "string" && /^\d+$/.test(id)))];
}

/** 从任意输入整理出合法的隐藏工坊 id 列表。 */
function sanitizeHiddenIds(value, fallback = []) {
	return sanitizeIdList(value, fallback);
}

const IMAGE_MIME = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
	".avif": "image/avif"
};

const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
/** Uploads land in one plugin-owned directory under $DSH_HOME-shaped layout. */
function uploadDir() {
	return join(homedir(), ".dsh", "bg-image", "backgrounds");
}

/** Keep only the basename, strip anything unsafe, and pin a known extension. */
function safeUploadName(originalName) {
	const ext = extname(originalName).toLowerCase();
	if (!Object.hasOwn(IMAGE_MIME, ext)) return null;
	const base = originalName.slice(0, originalName.length - ext.length)
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
	return `${base || "background"}${ext}`;
}

/** Read this plugin's settings section; missing provider or section → defaults. */
function readConfig(ctx) {
	const settings = ctx.get("settings");
	if (settings === undefined) return {};
	return settings.get(SETTINGS_NAMESPACE) ?? {};
}

/** Strip the quotes users often paste around copied paths. */
function normalizePath(value) {
	if (typeof value !== "string") return "";
	return value.trim().replace(/^"(.*)"$/, "$1");
}

/** Clamp an overlay opacity into the schema's 0–0.9 range. */
function clampOpacityHost(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return 0.35;
	return Math.min(0.9, Math.max(0, n));
}

/** Empty imagePath selects the bundled default; anything else is used as-is. */
function resolveImagePath(cfg) {
	const configured = normalizePath(cfg.imagePath);
	return configured === "" ? DEFAULT_IMAGE_PATH : configured;
}

// ── Wallpaper Engine 集成 ────────────────────────────────────────────────────

/** Steam 根目录下的所有库路径（解析 libraryfolders.vdf）。 */
async function steamLibraryDirs(steamRoot) {
	const libs = [];
	try {
		const vdf = await readFile(join(steamRoot, "steamapps", "libraryfolders.vdf"), "utf8");
		for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.push(m[1].replace(/\\\\/g, "\\"));
	} catch {
		// 无 vdf 时至少把根目录本身当作库
		libs.push(steamRoot);
	}
	return libs;
}

/** 自动发现所有 Wallpaper Engine 创意工坊内容目录（HKCU 注册表 + 各库目录）。 */
async function detectWorkshopDirs() {
	const dirs = [];
	const roots = [];
	try {
		const { stdout } = await execFileAsync("reg", ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"]);
		const m = /SteamPath\s+REG_SZ\s+(\S+)/.exec(stdout);
		if (m) roots.push(m[1].replace(/\//g, "\\"));
	} catch { /* Steam 未安装或注册表不可读 */ }
	for (const root of roots) {
		for (const lib of await steamLibraryDirs(root)) {
			dirs.push(join(lib, "steamapps", "workshop", "content", WALLPAPER_ENGINE_APP_ID));
		}
	}
	const existing = [];
	for (const dir of dirs) {
		try {
			await readdir(dir);
			existing.push(dir);
		} catch { /* 该库没有 WE 内容 */ }
	}
	return existing;
}

/** 解析配置声明的工坊目录：手动绑定优先，否则自动发现。 */
async function activeWorkshopDirs(cfg) {
	const manual = normalizePath(cfg.workshopPath);
	if (manual !== "") return [{ dir: manual, auto: false }];
	const dirs = await detectWorkshopDirs();
	return dirs.map((dir) => ({ dir, auto: true }));
}

/** 从 Wallpaper Engine 本体 config.json 提取播放列表与当前桌面壁纸的工坊 id。 */
async function readWeUsage(workshopDirs) {
	const playlistIds = [];
	const currentIds = new Set();
	const idRe = /[\\/]431960[\\/](\d+)(?:[\\/]|$)/;
	for (const { dir } of workshopDirs) {
		const steamapps = resolvePath(dir, "..", "..", "..");
		let cfg;
		try {
			cfg = JSON.parse(await readFile(join(steamapps, "common", "wallpaper_engine", "config.json"), "utf8"));
		} catch {
			continue;
		}
		for (const userCfg of Object.values(cfg)) {
			const selected = userCfg?.general?.wallpaperconfig?.selectedwallpapers;
			if (typeof selected !== "object" || selected === null) continue;
			for (const monitor of Object.values(selected)) {
				const file = typeof monitor?.file === "string" ? monitor.file.replace(/\//g, "\\") : "";
				const m = idRe.exec(file);
				if (m) currentIds.add(m[1]);
				const items = Array.isArray(monitor?.playlist?.items) ? monitor.playlist.items : [];
				for (const item of items) {
					if (typeof item !== "string") continue;
					const mi = idRe.exec(item.replace(/\//g, "\\"));
					if (mi && !playlistIds.includes(mi[1])) playlistIds.push(mi[1]);
				}
			}
		}
	}
	return { playlistIds, currentIds };
}

/** 枚举一个工坊目录下的全部壁纸（project.json 元数据，容忍个别坏项）。 */
async function listWorkshopWallpapers(dir, activeImagePath, usage) {
	const entries = [];
	let ids;
	try {
		ids = await readdir(dir);
	} catch {
		return entries;
	}
	const frameDir = join(homedir(), ".dsh", "bg-image", "frames");
	const lower = activeImagePath.toLowerCase();
	const playlistRank = new Map(usage.playlistIds.map((id, i) => [id, i]));
	await Promise.all(ids.filter((id) => /^\d+$/.test(id)).map(async (id) => {
		const folder = join(dir, id);
		try {
			const meta = JSON.parse(await readFile(join(folder, "project.json"), "utf8"));
			const type = String(meta.type ?? "").toLowerCase();
			const preview = typeof meta.preview === "string" ? meta.preview : "";
			const file = typeof meta.file === "string" ? meta.file : "";
			// 背景用图：image 类型用原图；视频可抽原生帧；其余用预览图
			const bgRelative = type === "image" && file !== "" ? file : preview;
			if (preview === "" && bgRelative === "") return;
			const candidates = [
				bgRelative !== "" ? resolvePath(folder, bgRelative) : "",
				join(frameDir, `${id}.jpg`)
			].map((p) => p.toLowerCase());
			entries.push({
				id,
				title: typeof meta.title === "string" && meta.title !== "" ? meta.title : id,
				type: type || "unknown",
				hd: type === "video",
				inPlaylist: playlistRank.has(id),
				isWeCurrent: usage.currentIds.has(id),
				active: activeImagePath !== "" && candidates.includes(lower)
			});
		} catch { /* 跳过损坏的壁纸项 */ }
	}));
	return entries;
}

/** 排序：播放列表成员（按列表顺序）→ WE 当前壁纸 → 其余按标题。 */
function sortWallpaperEntries(entries, usage) {
	const playlistRank = new Map(usage.playlistIds.map((id, i) => [id, i]));
	const rank = (e) => e.inPlaylist ? 0 : e.isWeCurrent ? 1 : 2;
	entries.sort((a, b) =>
		rank(a) - rank(b) ||
		(playlistRank.get(a.id) ?? 0) - (playlistRank.get(b.id) ?? 0) ||
		a.title.localeCompare(b.title, "zh-Hans-CN")
	);
	return entries;
}

async function fileExists(p) {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

/** ffmpeg 可用性（一次性探测，缓存结果）。视频壁纸用它抽原生分辨率帧。 */
let ffmpegOk = null;
async function hasFfmpeg() {
	if (ffmpegOk === null) {
		try {
			await execFileAsync("ffmpeg", ["-version"], { timeout: 5000, windowsHide: true });
			ffmpegOk = true;
		} catch {
			ffmpegOk = false;
		}
	}
	return ffmpegOk;
}

/** 从视频壁纸抽一帧（-q:v 2 高质量 JPEG），结果按工坊 id 缓存。 */
async function extractVideoFrame(videoPath, id) {
	const dir = join(homedir(), ".dsh", "bg-image", "frames");
	await mkdir(dir, { recursive: true });
	const out = join(dir, `${id}.jpg`);
	if (await fileExists(out)) return out;
	const tmp = join(dir, `.${id}.extracting.jpg`);
	await execFileAsync(
		"ffmpeg",
		["-y", "-ss", "1", "-i", videoPath, "-frames:v", "1", "-q:v", "2", tmp],
		{ timeout: 25_000, windowsHide: true }
	);
	await rename(tmp, out);
	return out;
}

const VIDEO_EXT = /\.(mp4|webm|mkv|mov|m4v)$/i;

/**
 * 定位某个壁纸要作为背景/预览提供的文件，并确保解析结果仍在工坊目录内
 * （防止把 id/../ 当成任意文件读取的穿越）。
 * 背景选取优先级：image 类型原图 > 视频抽帧（需 ffmpeg，原生分辨率）> 预览图。
 */
async function resolveWallpaperFile(dirs, id, kind) {
	if (!/^\d+$/.test(id)) return null;
	for (const { dir } of dirs) {
		const folder = join(dir, id);
		let meta;
		try {
			meta = JSON.parse(await readFile(join(folder, "project.json"), "utf8"));
		} catch {
			continue;
		}
		const type = String(meta.type ?? "").toLowerCase();
		const preview = typeof meta.preview === "string" ? meta.preview : "";
		const file = typeof meta.file === "string" ? meta.file : "";
		const under = (relative) => {
			if (relative === "") return null;
			const full = resolvePath(folder, relative);
			const normalizedDir = resolvePath(dir);
			const lower = full.toLowerCase();
			if (lower.startsWith(normalizedDir.toLowerCase() + "\\") || lower.startsWith(normalizedDir.toLowerCase() + "/")) {
				return full;
			}
			return null;
		};
		if (kind === "preview") {
			const full = under(preview);
			if (full !== null) return full;
			continue;
		}
		if (type === "image") {
			const full = under(file);
			if (full !== null) return full;
		}
		if (type === "video" && VIDEO_EXT.test(file) && (await hasFfmpeg())) {
			const video = under(file);
			if (video !== null) {
				try {
					return await extractVideoFrame(video, id);
				} catch { /* 抽帧失败回退预览图 */ }
			}
		}
		const full = under(preview);
		if (full !== null) return full;
	}
	return null;
}

/** Collect one request body as a UTF-8 string, size-capped. */
function readBodyText(req, maxBytes = 64 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > maxBytes) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** Collect one request body as raw bytes, size-capped. */
function readBodyBytes(req, maxBytes) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > maxBytes) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/**
 * Register the settings section and the plugin's HTTP surface when their
 * optional Host services are composed.
 * @param ctx - Host context that may acquire settings and HTTP services.
 */
function apply(ctx) {
	let ownerScope = null;
	ctx.inject(["settings"], (settingsCtx) => {
		ownerScope = settingsCtx.settings.register(SETTINGS_NAMESPACE, BgSettingsSchema);
	});
	ctx.inject(["webServer"], (httpCtx) => {
		const sendJson = (res, status, value) => {
			res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			res.end(JSON.stringify(value));
		};
		const serveImage = async (req, res) => {
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405);
				res.end();
				return;
			}
			const imagePath = resolveImagePath(readConfig(ctx));
			if (imagePath === "") {
				res.writeHead(404);
				res.end();
				return;
			}
			try {
				const body = await readFile(imagePath);
				res.writeHead(200, {
					"content-type": IMAGE_MIME[extname(imagePath).toLowerCase()] ?? "application/octet-stream",
					"cache-control": "no-cache"
				});
				res.end(req.method === "HEAD" ? undefined : body);
			} catch {
				res.writeHead(404);
				res.end();
			}
		};
		const serveConfig = async (req, res) => {
			if (req.method === "GET") {
				sendJson(res, 200, { value: readConfig(ctx) });
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(405);
				res.end();
				return;
			}
			if (ownerScope === null) {
				sendJson(res, 503, { error: "settings not ready" });
				return;
			}
			let section;
			try {
				section = JSON.parse(await readBodyText(req));
			} catch {
				sendJson(res, 400, { error: "invalid JSON body" });
				return;
			}
			if (typeof section !== "object" || section === null || Array.isArray(section)) {
				sendJson(res, 400, { error: "body must be a JSON object" });
				return;
			}
			// 未出现的字段沿用当前值，避免部分更新清掉其他设置
			const before = readConfig(ctx);
			const clean = {
				enabled: typeof section.enabled === "boolean" ? section.enabled : before.enabled === true,
				imagePath: typeof section.imagePath === "string" ? normalizePath(section.imagePath) : normalizePath(before.imagePath),
				opacity: section.opacity === undefined ? clampOpacityHost(before.opacity) : clampOpacityHost(section.opacity),
				sidebarTransparent: typeof section.sidebarTransparent === "boolean" ? section.sidebarTransparent : before.sidebarTransparent !== false,
				workshopPath: typeof section.workshopPath === "string" ? normalizePath(section.workshopPath) : normalizePath(before.workshopPath),
				hiddenIds: sanitizeIdList(section.hiddenIds, before.hiddenIds),
				extraIds: sanitizeIdList(section.extraIds, before.extraIds),
				galleryMode: section.galleryMode === "all" || section.galleryMode === "curated" ? section.galleryMode : (before.galleryMode ?? "curated")
			};
			try {
				await ownerScope.replace(clean);
				sendJson(res, 200, { value: readConfig(ctx) });
			} catch (error) {
				sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		};
		const serveUpload = async (req, res) => {
			if (req.method !== "POST") {
				res.writeHead(405);
				res.end();
				return;
			}
			if (ownerScope === null) {
				sendJson(res, 503, { error: "settings not ready" });
				return;
			}
			const url = new URL(req.url ?? "/", "http://x");
			const name = safeUploadName(url.searchParams.get("name") ?? "");
			if (name === null) {
				sendJson(res, 400, { error: "不支持的图片格式（支持 png/jpg/webp/gif/bmp/avif）" });
				return;
			}
			let bytes;
			try {
				bytes = await readBodyBytes(req, UPLOAD_MAX_BYTES);
			} catch {
				sendJson(res, 413, { error: `图片超过大小限制（${UPLOAD_MAX_BYTES / 1024 / 1024}MB）` });
				return;
			}
			if (bytes.length === 0) {
				sendJson(res, 400, { error: "空文件" });
				return;
			}
			const dir = uploadDir();
			const finalPath = join(dir, name);
			const tempPath = join(dir, `.${name}.uploading`);
			try {
				await mkdir(dir, { recursive: true });
				await writeFile(tempPath, bytes);
				await rename(tempPath, finalPath);
			} catch (error) {
				sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
				return;
			}
			const current = readConfig(ctx);
			try {
				await ownerScope.replace({
					enabled: true,
					imagePath: finalPath,
					opacity: clampOpacityHost(current.opacity),
					sidebarTransparent: current.sidebarTransparent !== false,
					workshopPath: normalizePath(current.workshopPath),
					hiddenIds: sanitizeIdList(current.hiddenIds),
					extraIds: sanitizeIdList(current.extraIds),
					galleryMode: current.galleryMode ?? "curated"
				});
				sendJson(res, 200, { value: readConfig(ctx), fileName: name });
			} catch (error) {
				sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		};
		const serveWallpapers = async (req, res) => {
			if (req.method !== "GET") {
				res.writeHead(405);
				res.end();
				return;
			}
			const cfg = readConfig(ctx);
			const dirs = await activeWorkshopDirs(cfg);
			const activeImagePath = normalizePath(cfg.imagePath);
			const usage = await readWeUsage(dirs);
			const cfgNow = readConfig(ctx);
			const hidden = new Set(sanitizeIdList(cfgNow.hiddenIds));
			const extra = new Set(sanitizeIdList(cfgNow.extraIds));
			const mode = cfgNow.galleryMode === "all" ? "all" : "curated";
			const wallpapers = [];
			for (const { dir } of dirs) {
				wallpapers.push(...await listWorkshopWallpapers(dir, activeImagePath, usage));
			}
			for (const entry of wallpapers) {
				entry.hidden = hidden.has(entry.id);
				entry.extra = extra.has(entry.id);
				entry.curated = entry.inPlaylist || entry.isWeCurrent;
				entry.visible = !entry.hidden && (mode === "all" || entry.curated || entry.extra);
			}
			sortWallpaperEntries(wallpapers, usage);
			sendJson(res, 200, {
				detected: dirs.length > 0,
				auto: dirs[0]?.auto ?? false,
				workshopPath: dirs[0]?.dir ?? "",
				galleryMode: mode,
				count: wallpapers.filter((w) => w.visible).length,
				moreCount: wallpapers.filter((w) => !w.visible && !w.hidden).length,
				hiddenCount: wallpapers.filter((w) => w.hidden).length,
				wallpapers
			});
		};
		const serveWallpaperFile = async (req, res) => {
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405);
				res.end();
				return;
			}
			const url = new URL(req.url ?? "/", "http://x");
			const id = url.searchParams.get("id") ?? "";
			const kind = url.searchParams.get("kind") === "preview" ? "preview" : "bg";
			const file = await resolveWallpaperFile(await activeWorkshopDirs(readConfig(ctx)), id, kind);
			if (file === null) {
				res.writeHead(404);
				res.end();
				return;
			}
			try {
				const body = await readFile(file);
				res.writeHead(200, {
					"content-type": IMAGE_MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
					"cache-control": "no-cache"
				});
				res.end(req.method === "HEAD" ? undefined : body);
			} catch {
				res.writeHead(404);
				res.end();
			}
		};
		const serveWallpaperApply = async (req, res) => {
			if (req.method !== "POST") {
				res.writeHead(405);
				res.end();
				return;
			}
			if (ownerScope === null) {
				sendJson(res, 503, { error: "settings not ready" });
				return;
			}
			let body;
			try {
				body = JSON.parse(await readBodyText(req));
			} catch {
				sendJson(res, 400, { error: "invalid JSON body" });
				return;
			}
			const current = readConfig(ctx);
			const file = await resolveWallpaperFile(
				await activeWorkshopDirs(current),
				typeof body.id === "string" ? body.id : "",
				"bg"
			);
			if (file === null) {
				sendJson(res, 404, { error: "未找到该壁纸（可尝试刷新列表）" });
				return;
			}
			try {
				await ownerScope.replace({
					enabled: true,
					imagePath: file,
					opacity: clampOpacityHost(current.opacity),
					sidebarTransparent: current.sidebarTransparent !== false,
					workshopPath: normalizePath(current.workshopPath),
					hiddenIds: sanitizeIdList(current.hiddenIds),
					extraIds: sanitizeIdList(current.extraIds),
					galleryMode: current.galleryMode ?? "curated"
				});
				sendJson(res, 200, { value: readConfig(ctx) });
			} catch (error) {
				sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		};
		httpCtx.effect(() => httpCtx.webServer.register({
			kind: "exact",
			path: "/dsh-bg/image",
			handler: serveImage
		}), "dsh-bg-image: image route");
		httpCtx.effect(() => httpCtx.webServer.register({
			kind: "exact",
			path: "/dsh-bg/config",
			handler: serveConfig
		}), "dsh-bg-image: config route");
		httpCtx.effect(() => httpCtx.webServer.register({
			kind: "exact",
			path: "/dsh-bg/upload",
			handler: serveUpload
		}), "dsh-bg-image: upload route");
		httpCtx.effect(() => httpCtx.webServer.register({
			kind: "exact",
			path: "/dsh-bg/wallpapers",
			handler: serveWallpapers
		}), "dsh-bg-image: wallpapers list route");
		httpCtx.effect(() => httpCtx.webServer.register({
			kind: "exact",
			path: "/dsh-bg/wallpaper-file",
			handler: serveWallpaperFile
		}), "dsh-bg-image: wallpaper file route");
		httpCtx.effect(() => httpCtx.webServer.register({
			kind: "exact",
			path: "/dsh-bg/wallpaper-apply",
			handler: serveWallpaperApply
		}), "dsh-bg-image: wallpaper apply route");
	});
}

export { apply };
