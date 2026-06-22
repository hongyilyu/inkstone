import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function ChatMarkdown({ text }: { text: string }) {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			components={{
				a: ({ node, ...props }) => (
					<a {...props} target="_blank" rel="noreferrer noopener" />
				),
				// A wide GFM table would otherwise overflow the chat column (the
				// typography plugin only gives `pre` an x-scroll). Wrap it so a wide
				// table scrolls within its own box instead of breaking the layout.
				table: ({ node, ...props }) => (
					<div className="max-w-full overflow-x-auto">
						<table {...props} />
					</div>
				),
			}}
		>
			{text}
		</ReactMarkdown>
	);
}
