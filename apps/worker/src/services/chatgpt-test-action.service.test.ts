import { describe, expect, it } from "bun:test";
import { ChatGptTestActionService } from "./chatgpt-test-action.service.ts";

describe("ChatGptTestActionService", () => {
	it("records, dedupes identical payloads and flags conflicts", () => {
		const service = new ChatGptTestActionService();
		const first = service.record("request-1", "hello");
		expect(first.status).toBe("recorded");
		const second = service.record("request-1", "hello");
		expect(second.status).toBe("duplicate");
		if (first.status !== "conflict" && second.status !== "conflict")
			expect(second.record).toBe(first.record);
		expect(service.record("request-1", "other")).toEqual({
			status: "conflict",
		});
	});
});
