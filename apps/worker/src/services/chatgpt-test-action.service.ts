export type TestActionRecord = {
	requestId: string;
	message: string;
	recordedAt: string;
};

export type TestActionResult =
	| { status: "recorded"; record: TestActionRecord }
	| { status: "duplicate"; record: TestActionRecord }
	| { status: "conflict" };

export interface IChatGptTestActionService {
	record(requestId: string, message: string): TestActionResult;
}

// Simulated sandbox: in-memory only, never touches GitHub.
export class ChatGptTestActionService implements IChatGptTestActionService {
	private readonly records = new Map<string, TestActionRecord>();

	record(requestId: string, message: string): TestActionResult {
		const existing = this.records.get(requestId);
		if (existing) {
			return existing.message === message
				? { status: "duplicate", record: existing }
				: { status: "conflict" };
		}
		const record = {
			requestId,
			message,
			recordedAt: new Date().toISOString(),
		};
		this.records.set(requestId, record);
		return { status: "recorded", record };
	}
}
