// dsh-bg-image — host half.
// Registers the `bg-image` settings namespace for persistence (settings.yaml)
// and serves the config + image over the plugin's own HTTP surface, because the
// wire `settings.describe` allowlist is closed to third-party namespaces.
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
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
			const steamPrefix = join(steamCacheDir(), id + ".").toLowerCase();
			const isActive = activeImagePath !== "" && (
				candidates.includes(lower) ||
				lower.startsWith(steamPrefix + "\\") ||
				lower.startsWith(steamPrefix + "/")
			);
			entries.push({
				id,
				title: typeof meta.title === "string" && meta.title !== "" ? meta.title : id,
				type: type || "unknown",
				hd: type === "video" || type === "scene" || type === "web",
				inPlaylist: playlistRank.has(id),
				isWeCurrent: usage.currentIds.has(id),
				active: isActive
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

/** 读图片头部的像素尺寸（png/jpeg/gif），失败返回 null。 */
async function sniffImageDim(path) {
	let head;
	try {
		const handle = await readFile(path);
		head = handle.subarray(0, 64 * 1024);
	} catch {
		return null;
	}
	if (head.length > 24 && head[0] === 0x89 && head[1] === 0x50) {
		return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
	}
	if (head.length > 10 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) {
		return { w: head.readUInt16LE(6), h: head.readUInt16LE(8) };
	}
	if (head.length > 4 && head[0] === 0xff && head[1] === 0xd8) {
		let i = 2;
		while (i + 9 < head.length) {
			if (head[i] !== 0xff) {
				i += 1;
				continue;
			}
			const marker = head[i + 1];
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { h: head.readUInt16BE(i + 5), w: head.readUInt16BE(i + 7) };
			}
			if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
				i += 2;
				continue;
			}
			i += 2 + head.readUInt16BE(i + 2);
		}
	}
	return null;
}

/** 按文件头魔数识别图片扩展名（jpg/png/gif/webp/bmp），非图片返回 null。 */
function sniffImageExt(buf) {
	if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
	if (buf.length > 7 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
	if (buf.length > 5 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "gif";
	if (buf.length > 11 && buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "webp";
	if (buf.length > 1 && buf[0] === 0x42 && buf[1] === 0x4d) return "bmp";
	return null;
}

/** Steam 工坊 CDN 高清预览的缓存位置。 */
const steamCacheDir = () => join(homedir(), ".dsh", "bg-image", "steam");

/** 在 Steam 缓存目录里找某个 id 已下载的文件（任意扩展名）。 */
async function steamCacheFile(id) {
	const dir = steamCacheDir();
	let entries;
	try {
		entries = await readdir(dir);
	} catch {
		return null;
	}
	const found = entries.find((name) => name.startsWith(`${id}.`));
	return found ? join(dir, found) : null;
}

/** 对外请求的代理候选：直连 → 环境变量 → 常见本地代理端口。 */
function proxyCandidates() {
	const list = [null];
	for (const env of [process.env.HTTPS_PROXY, process.env.HTTP_PROXY]) {
		if (typeof env === "string" && env !== "" && !list.includes(env)) list.push(env);
	}
	for (const common of ["http://127.0.0.1:7897", "http://127.0.0.1:7890"]) {
		if (!list.includes(common)) list.push(common);
	}
	return list;
}

/**
 * 依次尝试各代理候选执行 curl；output 模式落盘返回 boolean，
 * 否则返回 stdout 字符串（无可用输出返回 null）。
 */
async function curlRun(url, { postBody = null, output = null } = {}) {
	for (const proxy of proxyCandidates()) {
		const args = ["-sL", "-f", "--max-time", "40"];
		if (proxy !== null) args.push("-x", proxy);
		if (postBody !== null) args.push("-d", postBody);
		if (output !== null) args.push("-o", output);
		args.push(url);
		try {
			const result = await execFileAsync("curl", args, {
				timeout: 45_000,
				windowsHide: true,
				maxBuffer: 16 * 1024 * 1024
			});
			if (output !== null) return true;
			if (typeof result.stdout === "string" && result.stdout.trim() !== "") return result.stdout;
		} catch { /* 换下一个候选 */ }
	}
	return null;
}

/** 用 curl（含代理回退）下载 url 到 destBase，按文件头魔数选扩展名落盘；成功返回最终路径。 */
async function curlDownload(url, destBase) {
	const dir = destBase.slice(0, destBase.lastIndexOf("\\"));
	try {
		await mkdir(dir, { recursive: true });
	} catch { /* 已存在 */ }
	const tmp = `${destBase}.downloading`;
	if (await curlRun(url, { output: tmp }) !== true) return null;
	const buf = await readFile(tmp).catch(() => Buffer.alloc(0));
	const ext = sniffImageExt(buf);
	if (ext === null || buf.length < 1024) {
		await unlink(tmp).catch(() => {});
		return null;
	}
	const finalPath = `${destBase}.${ext}`;
	await rename(tmp, finalPath);
	return finalPath;
}

/** 向 Steam 工坊 API 查询一件作品的原始预览图 URL（公开接口，免密钥）。 */
async function steamPreviewUrl(id) {
	const body = `itemcount=1&publishedfileids%5B0%5D=${id}`;
	const url = "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
			signal: AbortSignal.timeout(12_000)
		});
		if (response.ok) {
			const detail = (await response.json())?.response?.publishedfiledetails?.[0];
			if (detail?.result === 1 && typeof detail.preview_url === "string" && detail.preview_url.startsWith("http")) {
				return detail.preview_url;
			}
		}
	} catch { /* 直连失败，走 curl 代理链 */ }
	const stdout = await curlRun(url, { postBody: body });
	if (stdout === null) return null;
	try {
		const detail = JSON.parse(stdout)?.response?.publishedfiledetails?.[0];
		if (detail?.result === 1 && typeof detail.preview_url === "string") return detail.preview_url;
	} catch { /* 响应异常 */ }
	return null;
}

/**
 * 本地预览分辨率不足时，从 Steam CDN 拉作者上传的原始预览图（静态、通常 1080p+），
 * 按 id 缓存；任何网络失败都安静回退本地预览。
 */
async function upgradedScenePreview(id, localPath) {
	const dim = await sniffImageDim(localPath);
	if (dim !== null && dim.w >= 1600 && dim.h >= 900) return localPath;
	const cached = await steamCacheFile(id);
	if (cached !== null) return cached;
	const url = await steamPreviewUrl(id);
	if (url === null) return localPath;
	const final = await curlDownload(url, join(steamCacheDir(), id));
	return final !== null ? final : localPath;
}

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
		if (type === "scene" || type === "web") {
			const full = under(preview);
			if (full !== null) {
				try {
					return await upgradedScenePreview(id, full);
				} catch { /* 网络失败回退本地预览 */ }
			}
		}
		const full = under(preview);
		if (full !== null) return full;
	}
	return null;
}

/** 读取一件壁纸的 type（video/scene/web/image），失败返回 null。 */
async function wallpaperType(dirs, id) {
	if (!/^\d+$/.test(id)) return null;
	for (const { dir } of dirs) {
		try {
			const meta = JSON.parse(await readFile(join(dir, id, "project.json"), "utf8"));
			return String(meta.type ?? "").toLowerCase() || null;
		} catch { /* 尝试下一个工坊目录 */ }
	}
	return null;
}

/**
 * 不触发任何网络 / ffmpeg 的快速解析：已有缓存优先，否则直接本地预览 / 原图。
 * 用于应用时“先立刻出画面”，高清版本随后在后台静默升级替换。
 */
async function resolveInstantWallpaperFile(dirs, id) {
	if (!/^\d+$/.test(id)) return null;
	const steamCached = await steamCacheFile(id);
	if (steamCached !== null) return steamCached;
	const frameCached = join(homedir(), ".dsh", "bg-image", "frames", `${id}.jpg`);
	if (await fileExists(frameCached)) return frameCached;
	for (const { dir } of dirs) {
		const folder = join(dir, id);
		let meta;
		try {
			meta = JSON.parse(await readFile(join(folder, "project.json"), "utf8"));
		} catch {
			continue;
		}
		const type = String(meta.type ?? "").toLowerCase();
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
		if (type === "image") {
			const full = under(typeof meta.file === "string" ? meta.file : "");
			if (full !== null) return full;
		}
		const preview = under(typeof meta.preview === "string" ? meta.preview : "");
		if (preview !== null) return preview;
	}
	return null;
}

/**
 * 后台升级：在用户已瞬间看到预览之后，异步解析出最高清版本（视频抽帧 / Steam CDN 原图），
 * 若用户尚未换图则无缝替换为高清版；任何失败都安静保持当前预览。
 */
async function upgradeInBackground(ctx, dirs, id, instantPath, ownerScope) {
	const best = await resolveWallpaperFile(dirs, id, "bg");
	if (best === null || normalizePath(best) === normalizePath(instantPath)) return;
	const now = readConfig(ctx);
	if (normalizePath(now.imagePath) !== normalizePath(instantPath)) return; // 用户已切换壁纸
	await ownerScope.replace({
		enabled: true,
		imagePath: best,
		opacity: clampOpacityHost(now.opacity),
		sidebarTransparent: now.sidebarTransparent !== false,
		workshopPath: normalizePath(now.workshopPath),
		hiddenIds: sanitizeIdList(now.hiddenIds),
		extraIds: sanitizeIdList(now.extraIds),
		galleryMode: now.galleryMode ?? "curated"
	});
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
			const dirs = await activeWorkshopDirs(current);
			const id = typeof body.id === "string" ? body.id : "";
			// 1) 快速路径：立刻出画面（缓存优先，否则本地预览），不等网络 / 抽帧
			const instant = await resolveInstantWallpaperFile(dirs, id);
			if (instant === null) {
				sendJson(res, 404, { error: "未找到该壁纸（可尝试刷新列表）" });
				return;
			}
			try {
				await ownerScope.replace({
					enabled: true,
					imagePath: instant,
					opacity: clampOpacityHost(current.opacity),
					sidebarTransparent: current.sidebarTransparent !== false,
					workshopPath: normalizePath(current.workshopPath),
					hiddenIds: sanitizeIdList(current.hiddenIds),
					extraIds: sanitizeIdList(current.extraIds),
					galleryMode: current.galleryMode ?? "curated"
				});
			} catch (error) {
				sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
				return;
			}
			// 2) 后台升级：有高清可用（视频抽帧 / Steam CDN 原图）就异步替换，不阻塞响应
			const type = await wallpaperType(dirs, id);
			const upgrading = type === "video" || type === "scene" || type === "web";
			sendJson(res, 200, { value: readConfig(ctx), upgrading });
			if (upgrading) {
				upgradeInBackground(ctx, dirs, id, instant, ownerScope).catch(() => {});
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
