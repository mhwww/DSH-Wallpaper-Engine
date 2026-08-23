# dsh-bg-image

[DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) Web UI 的自定义背景图片插件。

- **Wallpaper Engine 集成**：自动发现 Steam 创意工坊目录（注册表 + `libraryfolders.vdf`，也支持手动绑定），在设置卡片里浏览全部壁纸缩略图，**点一下即设为 DSH 背景**（image 类型用原图，scene/video/web 类型用预览图，gif 预览会动）
- **内置默认背景**：插件自带一张渐变图（`assets/default-bg.png`），“恢复默认背景”一键切回
- **自定义上传**：点“选择图片…”从电脑选图立即应用，或直接填本机绝对路径
- 明暗主题自动适配（浅色叠白遮罩、深色叠黑遮罩），遮罩不透明度可调，侧边栏可选择透出背景

浏览器端（任何打开 dsh web 的浏览器）与 DSH 桌面壳共用同一插件。

## 工作原理

- **Host 半边**（`lib/index.js`）：注册 `bg-image` settings namespace（持久化到 `~/.dsh/settings.yaml`），并在 webserver 上挂三条路由：
  - `GET /dsh-bg/image` —— 按 `imagePath` 读本地图片流式返回（按扩展名设置 content-type）
  - `GET/POST /dsh-bg/config` —— 读取/整段写入本插件的配置（POST 经 schemastery schema 校验后落盘）
  - `POST /dsh-bg/upload?name=<文件名>` —— 接收图片字节（≤20MB，扩展名白名单校验），存到 `~/.dsh/bg-image/backgrounds/<安全文件名>` 并自动设为当前背景
  - `GET /dsh-bg/wallpapers` —— 枚举 Wallpaper Engine 创意工坊壁纸（自动发现或用配置的 `workshopPath`；读各文件夹 `project.json` 的标题/类型/预览，标注当前生效项）
  - `GET /dsh-bg/wallpaper-file?id=<工坊ID>&kind=preview|bg` —— 安全地提供壁纸预览/背景文件（解析结果必须落在工坊目录内，防路径穿越）
  - `POST /dsh-bg/wallpaper-apply {id}` —— 一键把某壁纸设为背景（保留透明度等其他设置）

`imagePath` 留空即使用内置默认背景；host 侧动态解析插件包内 `assets/default-bg.png` 的路径。
- **浏览器半边**（`lib/client.js`，`window.__ModuleLoader__.load` 自包含 bundle）：
  - 启动时 fetch 配置，调用官方主题 API `ctx.theme.overrideTokens()` 把 `--dsw-alias-bg-base` 覆盖成 `linear-gradient(遮罩), url(图片) center/cover`，`--dsw-specific-sidebar-fill` 覆盖为透明；深浅色各自一对值，随主题切换自动重渲染
  - 在 `settings.plugin.item` 槽位注册配置卡片（React，平台模块表里的 react，无额外依赖）：
    - **选择图片…**：隐藏 `<input type="file">` 触发系统文件对话框；选中后先用 `URL.createObjectURL` 即时预览，再把文件字节 POST 到 `/dsh-bg/upload`，host 保存并自动更新配置，背景立即生效
    - 路径输入框、透明度滑杆、两个开关走「保存」按钮（POST `/dsh-bg/config`）
  - 图片 URL 带 nonce 破缓存；窗口重新获得焦点时自动重拉配置

### 为什么不用官方 settingsScope？

dsh 的 wire 面 `settings.describe` 对浏览器只暴露**硬编码白名单**的 namespace（`ui-theme`、`agent-loop` 等，见 `dsh-host-apiproxy` 源码注释——插件自暴露是 deferred work），第三方 namespace 读不到。所以本插件经自己的 `/dsh-bg/config` 路由传输配置，与 `client-modules` 服务 bundle 的做法同理。

## 配置字段

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | bool | `false` | 总开关 |
| `imagePath` | string | `""` | 本地图片绝对路径（png/jpg/webp/gif/bmp/avif） |
| `opacity` | number | `0.35` | 遮罩不透明度 0–0.9；深色模式自动 +0.15 |
| `sidebarTransparent` | bool | `true` | 侧边栏填充透明，透出背景 |

## 安装（一键）

```sh
dsh plugin --profile web add github:mhwww/dsh-bg-image
```

重启 `dsh --profile web` 后，设置页 →「插件」里即可配置。升级：`dsh plugin --profile web update dsh-bg-image`。

> 需要已安装 dsh 和 pnpm（`corepack enable pnpm`）。从 git 安装时 pnpm 会自动解析依赖（`@deepseek-ai/dsh-settings`、`schemastery` 均在 npm 公开仓库）。
>
> 视频壁纸“高清帧”功能需要系统 PATH 里有 `ffmpeg`（缺失时自动回退预览图）；Steam 创意工坊目录自动发现依赖 Windows 注册表（其他平台请用卡片里的手动绑定）。

### 网络说明（国内用户）

`github:` 依赖安装时，pnpm 会先用自己的 HTTPS 探测解析 commit（读的是 npm/pnpm 代理配置，不读 git 的），再回退到 `git ls-remote`（读 git 自己的代理配置）。因此：

- 直连不稳的网络下，安装开头可能出现 2 行 `ETIMEDOUT` 重试警告——**最终仍会成功**（git 步骤通常可通）；个别失败重跑一次命令即可
- 想彻底避免警告，任选其一配好代理：
  ```sh
  pnpm config set proxy      http://127.0.0.1:7897   # 换成你的代理端口
  pnpm config set https-proxy http://127.0.0.1:7897
  # 或只给 git 配（pnpm 探测仍会警告，但克隆不受影响）：
  # git config --global http.https://github.com.proxy http://127.0.0.1:7897
  ```

## 开发安装（本仓库克隆后）

```sh
dsh plugin --profile web add <本仓库路径> --registry=https://registry.npmmirror.com
cd <本仓库路径> && pnpm install        # link: 安装下依赖在源码目录解析
dsh --profile web                      # 重启服务生效
```

`dsh plugin add` 会自动把包加进 profile 的 `dsh.profile.bundles`（本包带 `dsh.bundle` 声明与自带的 `cordis.patch.yml`，无需手工编辑组合层）。link: 方式安装时，修改 `lib/` 下的代码重启服务即生效。

## 卸载

```sh
dsh plugin --profile web remove dsh-bg-image
```

## 已知边界

- 卡片文案当前为中文硬编码（locale 字典已预留）
- 直接编辑 `settings.yaml` 中的 `bg-image` 段后，切回浏览器窗口会自动生效（focus 时重拉）
- 图片路径填错时预览隐藏、背景不应用，不会影响 dsh 本体

## License

MIT
