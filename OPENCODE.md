# OpenBrush для OpenCode

Для готовой сборки нужны Mac с Apple Silicon, Node.js 22+, Git и OpenCode 2.x. Храните клон в постоянной папке. Из каталога, в котором хотите разместить OpenBrush, выполните

```sh
git clone --depth 1 --branch runtime-v0.14.7-openbrush https://github.com/ex3lite/codex-openpencil.git openbrush
cd openbrush
npm run setup:opencode
opencode mcp list
```

Установщик скачивает движок из релиза этого форка, проверяет SHA-256 архива, ревизию и содержимое по манифесту. Затем он регистрирует `openbrush` в глобальных настройках через `opencode mcp add --global`. Codex и сборка Rust для установки не требуются.

Запустите `opencode` из папки, где должны храниться макеты. Попросите «Открой OpenBrush в браузере для текущего проекта и покажи ссылку на холст». Агент вызывает `canvas_open_browser` и возвращает локальный `panelUrl`. Оставьте сеанс OpenCode открытым, пока редактируете в браузере. Файлы `.op` и история сохраняются в проекте. Чтобы продолжить работу, запустите OpenCode в той же папке.

[Документация OpenCode по локальным MCP-серверам](https://opencode.ai/docs/mcp-servers/)
