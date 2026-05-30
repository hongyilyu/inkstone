import { Menu } from "@base-ui-components/react/menu";
import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { type Model, models } from "../data/mock.js";
import { Button } from "./ui/button.js";

export function ModelPicker({
	defaultModelId,
}: {
	defaultModelId: string;
}) {
	const initial = models.find((m) => m.id === defaultModelId) ?? models[0];
	const [selected, setSelected] = useState<Model>(initial);

	return (
		<Menu.Root>
			<Menu.Trigger
				render={
					<Button variant="chip" size="pill" aria-label="Select model">
						<span>{selected.name}</span>
						<ChevronDown className="h-4 w-4" aria-hidden />
					</Button>
				}
			/>
			<Menu.Portal>
				<Menu.Positioner sideOffset={6} align="start">
					<Menu.Popup className="min-w-[220px] rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
						{models.map((m) => (
							<Menu.Item
								key={m.id}
								onClick={() => setSelected(m)}
								className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
							>
								<Check
									className={
										m.id === selected.id
											? "h-3.5 w-3.5 text-primary"
											: "h-3.5 w-3.5 opacity-0"
									}
									aria-hidden
								/>
								<span className="flex-1">{m.name}</span>
								<span className="text-xs text-muted-foreground">
									{m.description}
								</span>
							</Menu.Item>
						))}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
