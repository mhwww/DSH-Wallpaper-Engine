// dsh-bg-image — browser half (self-contained client bundle).
// Overlays the active theme's background tokens with the configured image
// (light/dark aware dim layer) and registers a settings card for editing.
// Config travels over the plugin's own /dsh-bg/config route: the wire
// `settings.describe` allowlist is closed to third-party namespaces.
window.__ModuleLoader__.load({
	id: "dsh-bg-image",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const { useState, useEffect, Fragment } = require("react");
		const { jsx, jsxs } = require("react/jsx-runtime");

		const NS = "dsh-bg-image";
		const CONFIG_URL = "/dsh-bg/config";
		const IMAGE_URL = "/dsh-bg/image";
		const DEFAULTS = { enabled: false, imagePath: "", opacity: 0.35, sidebarTransparent: true, workshopPath: "", hiddenIds: [], extraIds: [], galleryMode: "curated" };

		const css = [
			".dbg-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}",
			".dbg-row{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px}",
			".dbg-rowLabel{min-width:150px;color:var(--dsw-alias-label-secondary)}",
			".dbg-input{flex:1;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:6px 10px}",
			".dbg-input:focus{outline:none;border-color:var(--dsw-static-neutral-bluish-400)}",
			".dbg-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-left:158px}",
			".dbg-preview{width:100%;height:96px;object-fit:cover;border-radius:8px;border:1px solid var(--dsw-alias-border-l2)}",
			".dbg-button{align-self:flex-end;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:6px 18px;cursor:pointer}",
			".dbg-button:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dbg-buttonPrimary{align-self:flex-start;border-color:transparent;background:var(--dsw-static-neutral-bluish-500,#4d6bfe);color:#fff;font-weight:600}",
			".dbg-buttonPrimary:hover{filter:brightness(1.08);background:var(--dsw-static-neutral-bluish-500,#4d6bfe)}",
			".dbg-hintInline{color:var(--dsw-alias-label-tertiary);font-size:12px}",
			".dbg-current{color:var(--dsw-alias-label-secondary);font-size:12px;min-width:150px}",
			".dbg-buttonGhost{align-self:flex-start;padding:4px 12px;font-size:12px}",
			".dbg-wpSection{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}",
			".dbg-wpHeader{display:flex;align-items:center;justify-content:space-between}",
			".dbg-wpTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}",
			".dbg-wpGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;max-height:320px;overflow-y:auto;padding:2px}",
			".dbg-wpItem{border:2px solid transparent;border-radius:8px;padding:0;background:none;cursor:pointer;overflow:hidden;height:72px}",
			".dbg-wpItem:hover{border-color:var(--dsw-alias-border-l2)}",
			".dbg-wpItemActive{border-color:var(--dsw-static-neutral-bluish-400)}",
			".dbg-wpThumb{width:100%;height:100%;object-fit:cover;display:block}",
			".dbg-wpItem{position:relative}",
			".dbg-wpBadge{position:absolute;right:3px;bottom:3px;background:rgba(77,107,254,.92);color:#fff;font-size:10px;line-height:1;padding:2px 5px;border-radius:4px}",
			".dbg-wpBadgeUse{right:auto;left:3px;bottom:auto;top:3px;background:rgba(122,92,255,.92)}",
			".dbg-wpHide{position:absolute;right:3px;top:3px;width:18px;height:18px;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:13px;line-height:17px;text-align:center;cursor:pointer;opacity:0;transition:opacity .12s}",
			".dbg-wpItem:hover .dbg-wpHide{opacity:1}",
			".dbg-wpHide:hover{background:rgba(220,60,60,.9)}",
			".dbg-wpManage{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dbg-wpItemHidden{opacity:.45}",
			".dbg-wpItemDim{opacity:.75}",
			".dbg-wpBadgeRestore{background:rgba(90,170,90,.92)}",
			".dbg-wpBadgeAdd{background:rgba(77,107,254,.92);font-size:13px;line-height:1;padding:2px 7px}",
			".dbg-flash{align-self:flex-end;color:var(--dsw-alias-label-secondary);font-size:12px}"
		].join("\n");
		const styleTagId = "dsh-bg-image/card.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(styleTagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = NS;
			tag.dataset.pluginCss = styleTagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		function clampOpacity(value) {
			const n = Number(value);
			if (!Number.isFinite(n)) return DEFAULTS.opacity;
			return Math.min(0.9, Math.max(0, n));
		}

		/** Compose the theme token overlay for one config snapshot. */
		function buildTokens(cfg, nonce) {
			const opacity = clampOpacity(cfg.opacity);
			const opacityDark = Math.min(0.9, opacity + 0.15);
			const image = `url("${IMAGE_URL}?r=${nonce}") center/cover no-repeat`;
			const tokens = {
				"--dsw-alias-bg-base": {
					light: `linear-gradient(rgba(255,255,255,${opacity.toFixed(2)}),rgba(255,255,255,${opacity.toFixed(2)})), ${image}`,
					dark: `linear-gradient(rgba(0,0,0,${opacityDark.toFixed(2)}),rgba(0,0,0,${opacityDark.toFixed(2)})), ${image}`
				}
			};
			if (cfg.sidebarTransparent !== false) {
				tokens["--dsw-specific-sidebar-fill"] = { light: "transparent", dark: "transparent" };
			}
			return tokens;
		}

		/** Settings card registered into the plugin settings page. */
		function Card({ host }) {
			const [snap, setSnap] = useState(() => host.snapshot());
			const [draft, setDraft] = useState(() => ({ ...DEFAULTS, ...(snap?.value ?? {}) }));
			const [flash, setFlash] = useState("");
			const [localPreview, setLocalPreview] = useState(null);
			const [wallpapers, setWallpapers] = useState(null);
			const [wpLoading, setWpLoading] = useState(false);
			const [wpError, setWpError] = useState("");
			useEffect(() => host.subscribe(() => setSnap(host.snapshot())), []);

			// ── Wallpaper Engine ──
			const loadWallpapers = async () => {
				setWpLoading(true);
				setWpError("");
				try {
					const response = await fetch("/dsh-bg/wallpapers");
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const body = await response.json();
					setWallpapers(body);
				} catch (error) {
					setWpError("壁纸列表加载失败：" + (error.message || error));
				} finally {
					setWpLoading(false);
				}
			};
			useEffect(() => { loadWallpapers(); }, []);
			const applyWallpaper = async (id) => {
				setFlash("saving");
				try {
					const response = await fetch("/dsh-bg/wallpaper-apply", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id })
					});
					if (!response.ok) {
						const detail = await response.json().catch(() => ({}));
						throw new Error(detail.error || `HTTP ${response.status}`);
					}
					const applied = await response.json();
					await host.refresh();
					setDraft((d) => ({ ...d, ...host.snapshot().value }));
					setFlash("saved");
					loadWallpapers();
					// 后台正在拉高清图（视频抽帧 / Steam CDN），稍后重拉配置即可无缝替换
					if (applied.upgrading) {
						setTimeout(() => host.refresh(), 2500);
						setTimeout(() => host.refresh(), 6000);
						setTimeout(() => host.refresh(), 15000);
					}
				} catch (error) {
					setFlash("failed");
					setWpError(String(error.message || error));
				}
			};
			const saveWorkshopPath = async () => {
				setFlash("saving");
				try {
					const current = host.snapshot().value ?? {};
					const response = await fetch(CONFIG_URL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							enabled: current.enabled === true,
							imagePath: current.imagePath ?? "",
							opacity: clampOpacity(draft.opacity),
							sidebarTransparent: draft.sidebarTransparent !== false,
							workshopPath: String(draft.workshopPath ?? "")
						})
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					await host.refresh();
					setFlash("saved");
					loadWallpapers();
				} catch {
					setFlash("failed");
				}
			};

			// ── 隐藏名单：右上角 × 移出画廊（不动 Steam 文件），可恢复 ──
			const setHiddenIds = async (ids) => {
				setFlash("saving");
				try {
					const current = host.snapshot().value ?? {};
					const response = await fetch(CONFIG_URL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							enabled: current.enabled === true,
							imagePath: current.imagePath ?? "",
							opacity: clampOpacity(draft.opacity),
							sidebarTransparent: draft.sidebarTransparent !== false,
							workshopPath: current.workshopPath ?? "",
							hiddenIds: ids
						})
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					await host.refresh();
					setFlash("saved");
					loadWallpapers();
				} catch {
					setFlash("failed");
				}
			};
			const hideWallpaper = (id) => {
				const current = host.snapshot().value ?? {};
				setHiddenIds([...(current.hiddenIds ?? []), id]);
			};
			const unhideWallpaper = (id) => {
				const current = host.snapshot().value ?? {};
				setHiddenIds((current.hiddenIds ?? []).filter((x) => x !== id));
			};

			// ── 更多壁纸：逐张添加 / 一键全显 / 恢复精选 ──
			const patchGallery = async (patch) => {
				setFlash("saving");
				try {
					const response = await fetch(CONFIG_URL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(patch)
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					await host.refresh();
					setFlash("saved");
					loadWallpapers();
				} catch {
					setFlash("failed");
				}
			};
			const addOne = (id) => {
				const current = host.snapshot().value ?? {};
				patchGallery({ extraIds: [...(current.extraIds ?? []), id] });
			};
			const showAll = () => patchGallery({ galleryMode: "all" });
			const backToCurated = () => patchGallery({ galleryMode: "curated" });
			const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

			// 文件选择 → 本地即时预览 → 上传 → 自动写入配置并应用
			const onPickFile = async (event) => {
				const file = event.target.files && event.target.files[0];
				event.target.value = "";
				if (!file) return;
				setFlash("uploading");
				setLocalPreview(URL.createObjectURL(file));
				try {
					const response = await fetch(`/dsh-bg/upload?name=${encodeURIComponent(file.name)}`, {
						method: "POST",
						headers: { "content-type": "application/octet-stream" },
						body: file
					});
					if (!response.ok) {
						const detail = await response.json().catch(() => ({}));
						throw new Error(detail.error || `HTTP ${response.status}`);
					}
					await host.refresh();
					setDraft((d) => ({ ...d, ...host.snapshot().value }));
					setFlash("saved");
				} catch (error) {
					setFlash("failed");
					setLocalPreview(null);
					console.error("[dsh-bg-image] upload failed:", error);
				}
			};

			const save = async () => {
				setFlash("saving");
				try {
					const response = await fetch(CONFIG_URL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							enabled: draft.enabled === true,
							imagePath: String(draft.imagePath ?? ""),
							opacity: clampOpacity(draft.opacity),
							sidebarTransparent: draft.sidebarTransparent !== false
						})
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					await host.refresh();
					setFlash("saved");
				} catch {
					setFlash("failed");
				}
			};

			// 一键恢复默认：清空自定义路径（空路径 = 插件内置默认背景），其余设置保留
			const resetToDefault = async () => {
				setFlash("saving");
				try {
					const current = host.snapshot().value ?? {};
					const response = await fetch(CONFIG_URL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							enabled: current.enabled === true || draft.enabled === true,
							imagePath: "",
							opacity: clampOpacity(draft.opacity),
							sidebarTransparent: draft.sidebarTransparent !== false
						})
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					await host.refresh();
					setDraft((d) => ({ ...d, imagePath: "" }));
					setFlash("saved");
				} catch {
					setFlash("failed");
				}
			};
			const isDefault = !(snap?.value?.imagePath);
			const currentLabel = isDefault ? "当前：默认背景" : `当前：${String(snap?.value?.imagePath ?? "").split(/[\\/]/).pop()}`;
			const allWallpapers = wallpapers?.wallpapers ?? [];
			const galleryMode = wallpapers?.galleryMode ?? "curated";
			const wallpapersList = allWallpapers.filter((w) => w.visible);
			const moreList = allWallpapers.filter((w) => !w.visible && !w.hidden);
			const hiddenList = allWallpapers.filter((w) => w.hidden);
			const usingWallpaper = wallpapersList.some((w) => w.active);
			const [showHidden, setShowHidden] = useState(false);
			const [showMore, setShowMore] = useState(false);
			return jsxs("div", {
				className: "dbg-card",
				children: [
					jsxs("div", { className: "dbg-row", children: [
						jsx("input", {
							id: "dbg-enable",
							type: "checkbox",
							checked: draft.enabled === true,
							onChange: (e) => set("enabled", e.target.checked)
						}),
						jsx("label", { htmlFor: "dbg-enable", children: "启用背景" })
					] }),
					jsxs("div", { className: "dbg-row", children: [
						jsx("button", {
							className: "dbg-button dbg-buttonPrimary",
							type: "button",
							onClick: () => document.getElementById("dbg-file-input").click(),
							children: "选择图片…"
						}),
						jsx("span", {
							className: "dbg-hintInline",
							children: "从电脑中选择图片，立即应用"
						}),
						jsx("input", {
							id: "dbg-file-input",
							type: "file",
							accept: "image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif",
							style: { display: "none" },
							onChange: onPickFile
						})
					] }),
					jsx("div", { className: "dbg-row", children: [
						jsx("span", { className: "dbg-current", children: currentLabel }),
						!isDefault && jsx("button", {
							className: "dbg-button dbg-buttonGhost",
							type: "button",
							onClick: resetToDefault,
							children: "恢复默认背景"
						})
					] }),
					jsxs("div", { className: "dbg-row", children: [
						jsx("span", { className: "dbg-rowLabel", children: "图片路径" }),
						jsx("input", {
							className: "dbg-input",
							type: "text",
							placeholder: "D:\\Pictures\\background.png",
							value: draft.imagePath ?? "",
							onChange: (e) => set("imagePath", e.target.value)
						})
					] }),
					jsx("div", { className: "dbg-hint", children: "也可以直接填写本机图片的绝对路径（png / jpg / webp / gif）" }),
					jsxs("div", { className: "dbg-wpSection", children: [
						jsxs("div", { className: "dbg-wpHeader", children: [
							jsx("span", { className: "dbg-wpTitle", children: "Wallpaper Engine 壁纸" }),
							jsx("button", {
								className: "dbg-button dbg-buttonGhost",
								type: "button",
								onClick: loadWallpapers,
								disabled: wpLoading,
								children: wpLoading ? "加载中…" : "刷新"
							})
						] }),
						wallpapers === null && !wpLoading && jsx("div", { className: "dbg-hintInline", children: "正在加载创意工坊壁纸…" }),
						wallpapers !== null && !wallpapers.detected && jsxs("div", { children: [
							jsx("div", { className: "dbg-hintInline", children: "未自动找到 Wallpaper Engine 创意工坊目录，请手动绑定：" }),
							jsxs("div", { className: "dbg-row", style: { marginTop: "6px" }, children: [
								jsx("input", {
									className: "dbg-input",
									type: "text",
									placeholder: "D:\\game\\steam\\steamapps\\workshop\\content\\431960",
									value: draft.workshopPath ?? "",
									onChange: (e) => set("workshopPath", e.target.value)
								}),
								jsx("button", { className: "dbg-button", type: "button", onClick: saveWorkshopPath, children: "绑定" })
							] })
						] }),
						wallpapers !== null && wallpapers.detected && jsxs("div", { className: "dbg-hintInline", children: [
							jsx("span", { children: (wallpapers.auto ? "已自动绑定：" : "已绑定：") + wallpapers.workshopPath + `（显示 ${wallpapers.count} 张` + (galleryMode === "curated" ? "，默认仅播放列表与使用中" : "，全部") + "）" })
						] }),
						wallpapersList.length > 0 && jsx("div", {
							className: "dbg-wpGrid",
							children: wallpapersList.map((w) => jsxs("button", {
								type: "button",
								className: w.active ? "dbg-wpItem dbg-wpItemActive" : "dbg-wpItem",
								title: w.title + "（" + w.type + (w.hd ? "，应用时自动获取高清图" : "") + "）",
								onClick: () => applyWallpaper(w.id),
								children: [
									jsx("img", {
										className: "dbg-wpThumb",
										src: `/dsh-bg/wallpaper-file?kind=preview&id=${w.id}`,
										alt: w.title,
										loading: "lazy",
										onError: (e) => { e.currentTarget.parentElement.style.opacity = "0.3"; }
									}),
									(w.inPlaylist || w.isWeCurrent) && jsx("span", {
										className: "dbg-wpBadge dbg-wpBadgeUse",
										children: w.isWeCurrent ? (w.inPlaylist ? "使用中·列表" : "使用中") : "播放列表"
									}),
									w.hd && jsx("span", { className: "dbg-wpBadge", children: "高清" }),
									jsx("span", {
										className: "dbg-wpHide",
										role: "button",
										title: "从列表移除（可在下方恢复）",
										onClick: (e) => {
											e.stopPropagation();
											hideWallpaper(w.id);
										},
										children: "×"
									})
								]
							}, w.id))
						}),
						wpError !== "" && jsx("div", { className: "dbg-hintInline", children: wpError }),
						jsxs("div", { className: "dbg-wpManage", children: [
							galleryMode === "curated"
								? jsxs(Fragment, { children: [
									jsx("span", { className: "dbg-hintInline", children: `更多壁纸 ${moreList.length} 张（未显示）` }),
									moreList.length > 0 && jsx("button", { className: "dbg-button dbg-buttonGhost", type: "button", onClick: () => setShowMore(!showMore), children: showMore ? "收起" : "浏览" }),
									moreList.length > 0 && jsx("button", { className: "dbg-button dbg-buttonGhost", type: "button", onClick: showAll, children: "全部添加" })
								] })
								: jsxs(Fragment, { children: [
									jsx("span", { className: "dbg-hintInline", children: "正在显示全部壁纸" }),
									jsx("button", { className: "dbg-button dbg-buttonGhost", type: "button", onClick: backToCurated, children: "恢复默认精选" })
								] })
						] }),
						showMore && galleryMode === "curated" && moreList.length > 0 && jsx("div", {
							className: "dbg-wpGrid",
							children: moreList.map((w) => jsxs("button", {
								type: "button",
								className: "dbg-wpItem dbg-wpItemDim",
								title: w.title + "（点击 + 添加到画廊）",
								onClick: () => addOne(w.id),
								children: [
									jsx("img", {
										className: "dbg-wpThumb",
										src: `/dsh-bg/wallpaper-file?kind=preview&id=${w.id}`,
										alt: w.title,
										loading: "lazy"
									}),
									jsx("span", { className: "dbg-wpBadge dbg-wpBadgeAdd", children: "+" })
								]
							}, w.id))
						}),
						hiddenList.length > 0 && jsxs("div", { className: "dbg-wpManage", children: [
							jsx("span", { className: "dbg-hintInline", children: `已隐藏 ${hiddenList.length} 张` }),
							jsx("button", {
								className: "dbg-button dbg-buttonGhost",
								type: "button",
								onClick: () => setShowHidden(!showHidden),
								children: showHidden ? "收起" : "管理"
							}),
							showHidden && jsx("div", {
								className: "dbg-wpGrid",
								style: { marginTop: "6px" },
								children: hiddenList.map((w) => jsxs("button", {
									type: "button",
									className: "dbg-wpItem dbg-wpItemHidden",
									title: w.title + "（点击恢复显示）",
									onClick: () => unhideWallpaper(w.id),
									children: [
										jsx("img", {
											className: "dbg-wpThumb",
											src: `/dsh-bg/wallpaper-file?kind=preview&id=${w.id}`,
											alt: w.title,
											loading: "lazy"
										}),
										jsx("span", { className: "dbg-wpBadge dbg-wpBadgeRestore", children: "恢复" })
									]
								}, w.id))
							})
						] }),
						usingWallpaper && jsx("div", { className: "dbg-hintInline", style: { marginTop: "4px" }, children: "再次点击其他缩略图可更换；“恢复默认背景”可回到内置默认图" })
					] }),
					jsxs("div", { className: "dbg-row", children: [
						jsx("span", { className: "dbg-rowLabel", children: "遮罩不透明度" }),
						jsx("input", {
							type: "range",
							min: "0",
							max: "0.9",
							step: "0.05",
							value: clampOpacity(draft.opacity),
							onChange: (e) => set("opacity", Number(e.target.value))
						}),
						jsx("span", { children: clampOpacity(draft.opacity).toFixed(2) })
					] }),
					jsxs("div", { className: "dbg-row", children: [
						jsx("input", {
							id: "dbg-sidebar",
							type: "checkbox",
							checked: draft.sidebarTransparent !== false,
							onChange: (e) => set("sidebarTransparent", e.target.checked)
						}),
						jsx("label", { htmlFor: "dbg-sidebar", children: "侧边栏透出背景" })
					] }),
					jsx("img", {
						className: "dbg-preview",
						src: localPreview ?? `${IMAGE_URL}?r=${snap?.nonce ?? 0}`,
						alt: "preview",
						onError: (e) => { e.currentTarget.style.display = "none"; }
					}),
					jsxs("div", { style: { display: "flex", gap: "10px", alignItems: "center" }, children: [
						flash !== "" && jsx("span", { className: "dbg-flash", children: flash === "saved" ? "已保存" : flash === "saving" ? "保存中…" : flash === "uploading" ? "上传中…" : "操作失败" }),
						jsx("button", { className: "dbg-button", type: "button", onClick: save, children: "保存" })
					] })
				]
			});
		}

		const inject = ["theme", "slots", "locale"];

		function apply(ctx) {
			// 主持久化在 host 的 settings namespace；浏览器侧经插件自己的 /dsh-bg/config 读写
			const listeners = new Set();
			const state = { value: null, nonce: 0 };
			const host = {
				snapshot() {
					return { value: state.value, nonce: state.nonce };
				},
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				async refresh() {
					try {
						const response = await fetch(`${CONFIG_URL}?t=${Date.now()}`);
						if (!response.ok) return;
						const body = await response.json();
						state.value = body.value ?? null;
						state.nonce = Date.now();
					} catch {
						return;
					}
					for (const listener of listeners) listener();
					applyBackground();
				}
			};

			let disposeLayer = null;
			const applyBackground = () => {
				const cfg = state.value;
				if (disposeLayer !== null) {
					disposeLayer();
					disposeLayer = null;
				}
				if (cfg === null || cfg.enabled !== true) return;
				try {
					disposeLayer = ctx.theme.overrideTokens(NS, buildTokens(cfg, state.nonce));
				} catch (error) {
					console.error("[dsh-bg-image] overrideTokens failed:", error);
				}
			};

			ctx.effect(() => {
				host.refresh();
			}, "dsh-bg-image: initial config fetch");
			ctx.effect(() => {
				const onFocus = () => host.refresh();
				window.addEventListener("focus", onFocus);
				return () => window.removeEventListener("focus", onFocus);
			}, "dsh-bg-image: refetch on focus");
			ctx.effect(() => () => {
				if (disposeLayer !== null) {
					disposeLayer();
					disposeLayer = null;
				}
			}, "dsh-bg-image: token layer teardown");

			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				id: "bg-image",
				order: 40,
				locale: NS
			}, () => Card({ host })));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
