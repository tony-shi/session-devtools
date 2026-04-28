declare module "bun:sqlite" {
  // Existing route code builds parameter arrays dynamically; keep runtime code unchanged
  // while allowing the full server tree to typecheck under bun-types 1.3.x.
  interface Database {
    query<ReturnType = unknown, ParamsType = unknown[]>(sql: string): Statement<ReturnType, any[]>;
  }

  interface Statement<ReturnType = unknown> {
    all(...params: any[]): ReturnType[];
    get(...params: any[]): ReturnType | null;
    run(...params: any[]): unknown;
  }
}
