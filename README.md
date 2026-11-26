# dsh-find-in-conversation

DeepSeek Harness（DSH）插件：在一个会话的问答记录里按关键字查找——`Ctrl+F` 唤起查找条，比翻滚动条快。

## 功能

- `Ctrl+F`（macOS `⌘F`）在会话区顶部、会话标题下方弹出查找条，输入即搜；
- 输入时只刷新命中数与高亮，**不抢焦点、不改选区、不滚动**，可以连续输入不被打断；
- 所有命中用黄底标出，当前命中用橙底区分；
- `Enter` 下一个、`Shift+Enter` 上一个，↑ / ↓ 按钮同效；跳转时把命中滚到会话区中部；
- `Esc` 或 ✕ 关闭；显示「第 n / 共 m」，无命中显示「无匹配」，超过 500 个显示「共 500+」；
- 流式输出时命中数自动刷新并保持当前项；切换会话则重新开始查找；
- 查找条开启时再按 `Ctrl+F` 回到输入框并全选，方便换关键词。

## 覆盖范围

- 大小写不敏感，按纯文本匹配，不区分标题 / 正文 / 代码块；
- 只匹配当前已渲染的内容（折叠起来、没有渲染的不计入）；
- 高亮用浏览器原生 CSS Custom Highlight API 绘制，跟着文字滚动、只出现在会话区内；
- `Ctrl+Shift+F`（派生会话）与 `Ctrl+Alt+F` 不受影响。

细节见 [docs/DETAIL.md](docs/DETAIL.md)。

## 安装

```bash
dsh plugin --profile desktop add github:scoaming/dsh-find-in-conversation
```

安装后重启 DSH，再到 设置 → 插件 里确认「会话内查找」已启用。

本地目录方式：

```bash
dsh plugin --profile desktop add link:C:/path/to/dsh-find-in-conversation
```

## 平台

纯前端插件（渲染层），Windows / macOS / Linux 通用。

## 开发

没有构建步骤，`client.js` 就是运行时加载的代码；改完 `Ctrl+R` 刷新页面即可生效。

## License

[MIT](LICENSE)
