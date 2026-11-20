import type { SerializerProtocol } from "@langchain/langgraph-checkpoint";

/**
 * LangGraph types `loadsTyped` as `Promise<any>`. This wrapper is the only
 * place that result is accepted, and it returns `unknown`.
 */
export async function loadTyped(
  serde: SerializerProtocol,
  type: string,
  data: Uint8Array | string,
): Promise<unknown> {
  const loaded: unknown = await serde.loadsTyped(type, data);
  return loaded;
}

export async function dumpTyped(
  serde: SerializerProtocol,
  value: unknown,
): Promise<[string, Uint8Array]> {
  return serde.dumpsTyped(value);
}
