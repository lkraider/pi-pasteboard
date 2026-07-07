import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureInput, extensionOptionsFromEnv } from "./capture.js";
import { cleanupOldPasteFiles } from "./pasteboard.js";

export default function (pi: ExtensionAPI) {
	const options = extensionOptionsFromEnv();

	pi.on("session_start", async () => {
		await cleanupOldPasteFiles(options).catch(() => undefined);
	});

	pi.on("input", async (event, ctx) => {
		try {
			const result = await captureInput(
				{
					text: event.text,
					source: event.source,
					mode: ctx.mode,
					images: event.images,
					attachments: (event as { attachments?: unknown[] }).attachments,
				},
				options,
			);

			if (result.action === "transform") {
				return { action: "transform", text: result.text };
			}
			return { action: "continue" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`pi-pasteboard failed to save large input; sending original text. ${message}`, "error");
			return { action: "continue" };
		}
	});
}
