import type { ResolvedSource, SourceSelector } from "../domain/types.js";

export interface SourceResolver {
  resolve(selector: SourceSelector): Promise<ResolvedSource>;
}
