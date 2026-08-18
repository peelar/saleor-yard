import type { EnvironmentRecord } from "../domain/types.js";

export interface EnvironmentRepository {
  save(record: EnvironmentRecord): Promise<void>;
  get(id: string): Promise<EnvironmentRecord>;
  list(): Promise<EnvironmentRecord[]>;
}
