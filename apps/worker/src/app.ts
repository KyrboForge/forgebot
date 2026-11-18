import { Hono } from "hono";
import type { AppDependencies } from "./dependencies.ts";
import createChatGptRoute from "./routes/chatgpt.route.ts";
import createGitHubWebhookRoute from "./routes/github-webhook.route.ts";
import createHealthRoute from "./routes/health.route.ts";

export default function createApp(deps: AppDependencies) {
	const app = new Hono();

	app.route("/health", createHealthRoute());

	app.route("/webhooks/github", createGitHubWebhookRoute(deps));

	app.route("/api/chatgpt", createChatGptRoute(deps));

	return app;
}
