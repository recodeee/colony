declare module 'better-sqlite3' {
  namespace Database {
    interface Options {
      readonly?: boolean;
    }

    interface RunResult {
      changes: number;
      lastInsertRowid: number | bigint;
    }

    interface Statement {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): RunResult;
    }

    interface Database {
      close(): void;
      exec(source: string): this;
      pragma(source: string): unknown;
      prepare(source: string): Statement;
      transaction<TArgs extends unknown[], TResult>(
        fn: (...args: TArgs) => TResult,
      ): (...args: TArgs) => TResult;
    }
  }

  interface DatabaseConstructor {
    new (filename: string, options?: Database.Options): Database.Database;
    (filename: string, options?: Database.Options): Database.Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
