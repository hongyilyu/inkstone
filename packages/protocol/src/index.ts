import { Schema as S } from "effect";

export const PostMessageParams = S.Struct({ prompt: S.String });
export type PostMessageParams = S.Schema.Type<typeof PostMessageParams>;

export const PostMessageResult = S.Struct({ run_id: S.String });
export type PostMessageResult = S.Schema.Type<typeof PostMessageResult>;

export const RunEvent = S.Union(
	S.Struct({ kind: S.Literal("text_delta"), delta: S.String }),
	S.Struct({ kind: S.Literal("done") }),
);
export type RunEvent = S.Schema.Type<typeof RunEvent>;

export const WorkerInbound = S.Struct({ prompt: S.String });
export type WorkerInbound = S.Schema.Type<typeof WorkerInbound>;

export const WorkerOutbound = RunEvent;
export type WorkerOutbound = S.Schema.Type<typeof WorkerOutbound>;
