export type Message = { role: "user" | "assistant"; text: string };

export function MessageList({ messages }: { messages: Message[] }) {
	return (
		<ol className="messages">
			{messages.map((m, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: append-only chat log
				<li key={i} className={`message message-${m.role}`}>
					{m.text}
				</li>
			))}
		</ol>
	);
}
