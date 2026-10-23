# 福州带娃周末出行

福州亲子周末出行指南 + 数据管理台。指南页按宝宝月龄、天气、起点距离智能筛选 120+ 亲子地点；数据台可管理云端起点、知识库、文档库并做数据分析。

## 🌐 常用网址（重点）

| 页面 / 资源 | 网址 | 说明 |
|------|------|------|
| 🗺️ 带娃指南 | https://zafaw.github.io/fuzhou-weekend/ | 主指南页（智能筛选亲子地点） |
| 🔐 数据管理台 | https://zafaw.github.io/fuzhou-weekend/data.html | 加密访问，管理密码 **770108** |
| 📲 安装 App（智能识别） | https://zafaw.github.io/fuzhou-weekend/install.html | 一个链接自动识别安卓 / iPhone，给出对应安装方式 |
| 🤖 安卓 APK 直下 | https://github.com/ZafaW/fuzhou-weekend/releases/download/v1.0/fuzhou-guide-v1.0.apk | 安卓安装包，装完桌面有「带娃指南」图标 |

## 说明
- **指南页**：内嵌 120+ 地点攻略与当日快照，自动按月龄、天气、起点距离筛选；高德底图与地理编码经后端代理。
- **数据管理台**：整页加密访问，进入需输入管理密码（默认 `770108`，可在后端环境变量 `ADMIN_PIN` 修改）。支持增删改起点 / 知识库 / 文档，以及分类数据分析。
- 数据实时读写 GitHub 仓库，后端做跨域与服务端令牌代理。
