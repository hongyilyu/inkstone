import { Effect, Stream } from "effect";
import { run } from "./index.js";

type Event = Parameters<Parameters<typeof run>[1]>[0];

const stdinLines: Stream.Stream<string, Error> = Stream.async<string, Error>(
	(emit) => {
		let buf = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk: string) => {
			buf += chunk;
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (line.length > 0) emit.single(line);
				nl = buf.indexOf("\n");
			}
		});
		process.stdin.on("end", () => emit.end());
		process.stdin.on("error", (e: Error) => emit.fail(e));
	},
);

const cliEmit = (event: Event): Effect.Effect<void> =>
	Effect.sync(() => {
		process.stdout.write(`${JSON.stringify(event)}\n`);
	});

Effect.runPromise(run(stdinLines, cliEmit)).then(
	() => process.exit(0),
	(e) => {
		console.error(e);
		process.exit(1);
	},
);
