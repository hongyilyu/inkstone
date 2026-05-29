export function Sidebar() {
	return (
		<aside className="sidebar">
			<button type="button" className="new-thread" disabled>
				New thread
			</button>
			<ul className="thread-list" />
		</aside>
	);
}
