import { WsClient } from "@inkstone/ui-sdk";
import { Effect, type ManagedRuntime, Stream } from "effect";
import { useState } from "react";
import "./App.css";
import { Composer } from "./Composer.js";
import { type Message, MessageList } from "./MessageList.js";
import { Sidebar } from "./Sidebar.js";

interface Props {
	runtime: ManagedRuntime.ManagedRuntime<WsClient, never>;
}

function App({ runtime }: Props) {
	const [messages, setMessages] = useState<Message[]>([]);

	const send = async (prompt: string) => {
		setMessages((prev) => [...prev, { role: "user", text: prompt }]);
		const runId = await runtime.runPromise(
			Effect.gen(function* () {
				const c = yield* WsClient;
				return yield* c.postMessage(prompt);
			}),
		);
		setMessages((prev) => [...prev, { role: "assistant", text: "" }]);
		await runtime.runPromise(
			Effect.gen(function* () {
				const c = yield* WsClient;
				yield* Stream.runForEach(c.subscribeRun(runId), (event) =>
					Effect.sync(() => {
						if (event.kind === "text_delta") {
							setMessages((prev) => {
								const next = prev.slice();
								const last = next[next.length - 1];
								if (last && last.role === "assistant") {
									next[next.length - 1] = {
										...last,
										text: last.text + event.delta,
									};
								}
								return next;
							});
						}
					}),
				);
			}),
		);
	};

	return (
		<div className="app">
			<Sidebar />
			<main className="chat">
				<MessageList messages={messages} />
				<Composer onSend={send} />
			</main>
		</div>
	);
}

export default App;
