import { createMcpApp } from "./mcp-app.ts";

const apiUrl = process.env.FORGEBOT_API_URL;
const readToken = process.env.FORGEBOT_CHATGPT_READ_TOKEN;
const writeToken = process.env.FORGEBOT_CHATGPT_WRITE_TOKEN;
if (!apiUrl || !readToken || !writeToken) {
	throw new Error(
		"FORGEBOT_API_URL, FORGEBOT_CHATGPT_READ_TOKEN and FORGEBOT_CHATGPT_WRITE_TOKEN are required",
	);
}
const { protocol, hostname } = new URL(apiUrl);
if (
	protocol !== "https:" &&
	!(protocol === "http:" && ["localhost", "127.0.0.1"].includes(hostname))
) {
	throw new Error("FORGEBOT_API_URL must be https (http only for localhost)");
}

const app = createMcpApp({
	apiUrl,
	readToken,
	writeToken,
	pluginToken: process.env.FORGEBOT_PLUGIN_TOKEN || undefined,
});

export default { port: Number(process.env.PORT ?? 3000), fetch: app.fetch };
