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
			}}
		>
			{text}
		</ReactMarkdown>
	);
}
