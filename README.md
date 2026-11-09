# ProjectionLab MCP Server

**Talk to an AI assistant about your retirement plan, and let it read and optionally update your numbers in [ProjectionLab](https://projectionlab.com) for you.**

ProjectionLab is a retirement and financial-planning app. This project connects it to an AI assistant that supports MCP servers, such as Claude Desktop or Claude Code, so you can ask questions in plain English about *your* actual plan. The assistant reads and edits your plan; ProjectionLab itself runs the projections, so you see the results (charts, Chance of Success) in the app.

- *"Walk me through what my plan assumes: returns, inflation, spending, and when Social Security starts."*
- *"Copy my plan as 'Returns -2%' and lower the stock and bond returns by 2 points in the copy, so I can compare the two in ProjectionLab."*
- *"Raise my travel spending to $12,000 a year."* (then check the effect in ProjectionLab)

The assistant can look at your plan, walk through the tradeoffs with you, and, only when you say so, make changes for you.

> **A note on trust and safety:** This tool can *change* your financial plan, so it's built to be careful. It starts in **read-only mode** (it can look but not touch). When you turn changes on, each change is a preview until the assistant explicitly confirms it, and the assistant is instructed to show you the preview and ask first. Every confirmed change is backed up first so it can be undone. Your ProjectionLab API key stays on your own computer and is never sent anywhere.

You do **not** need to be a programmer. The recommended path is to let your assistant do the technical setup for you. You'll mostly be answering a few questions and clicking a couple of buttons in your browser.

---

## What you'll need

1. A **ProjectionLab account** with **Plugins enabled**. In ProjectionLab, go to **Account Settings → Plugins**, turn plugins on, and copy your **Plugin API Key** (a long code; keep it handy, since you'll give it to your assistant).
2. An **AI assistant that supports MCP servers** (Claude Desktop, Claude Code, and others). If your assistant can "add an MCP server," it can use this.
3. A **web browser** you already use: Chrome, Edge, Brave, or Firefox (version 140 or newer).
4. **Node.js** installed on your computer (version 20 or newer). If you don't have it, your assistant can help you install it, or download it from [nodejs.org](https://nodejs.org).

---

## The easy way: let your assistant set it up

Open your AI assistant and give it this instruction (copy-paste it as-is):

> Please set up the ProjectionLab MCP server (the `projectionlab-mcp` npm
> package) for me. Follow the setup instructions at
> `https://github.com/Backroads4Me/projectionlab-mcp/blob/main/SETUP-FOR-AGENTS.md`.
> I'm not technical, so walk me through anything you need from me (like my
> ProjectionLab Plugin API key and loading the browser extension) one step at
> a time. Keep it in read-only mode until I say otherwise.

Your assistant will download the project, install it, and hand you a couple of short, click-by-click steps in your browser (loading a small helper extension and pasting in a code). When it's done, just start asking questions about your plan.

If anything gets stuck, tell your assistant what you see on screen; it can troubleshoot from there.

---

## Manual setup from source

```bash
npm install
npm run build
cd extension && npm install && npm run build   # build the extension
```

Copy your **Plugin API Key** from ProjectionLab → Account Settings → Plugins (enable plugins first) and save it as `PL_API_KEY=...` in `~/.projectionlab-mcp/.env` (`chmod 600`).

Register `node /absolute/path/to/projectionlab-mcp/dist/index.js` with your MCP host ([host examples](https://github.com/Backroads4Me/projectionlab-mcp/blob/main/REFERENCE.md#adding-the-server-to-your-mcp-host)) and restart it; on first start the server creates the token at `~/.projectionlab-mcp/ws-token`. Load the built extension (`extension/dist/chromium` or `extension/dist/firefox`), enter port `8788` and that token on its options page, then run `projectionlab_check_connection`.

---

## More documentation

- **[Technical reference](https://github.com/Backroads4Me/projectionlab-mcp/blob/main/REFERENCE.md)**: host configuration, environment variables, tools, resources, prompts, and the safety model.
- **[How it works](https://github.com/Backroads4Me/projectionlab-mcp/blob/main/HOW-IT-WORKS.md)**: the architecture, wire protocol, extension internals, and security.
- **[Privacy](https://github.com/Backroads4Me/projectionlab-mcp/blob/main/PRIVACY.md)**: what the extension and server access and store.
- **[Setup for AI assistants](https://github.com/Backroads4Me/projectionlab-mcp/blob/main/SETUP-FOR-AGENTS.md)**: the install steps your assistant follows.
