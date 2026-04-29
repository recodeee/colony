import { join } from 'node:path';
import { type Settings, resolveDataDir } from '@colony/config';
import { MemoryStore } from '@colony/core';
import { Storage } from '@colony/storage';

export function dataDbPath(settings: Settings): string {
  return join(resolveDataDir(settings.dataDir), 'data.db');
}

export async function withStore<T>(
  settings: Settings,
  run: (store: MemoryStore) => T | Promise<T>,
  options: { readonly?: boolean } = {},
): Promise<T> {
  const store = new MemoryStore({ dbPath: dataDbPath(settings), settings, ...options });
  try {
    return await run(store);
  } finally {
    store.close();
  }
}

export async function withStorage<T>(
  settings: Settings,
  run: (storage: Storage) => T | Promise<T>,
  options: { readonly?: boolean } = {},
): Promise<T> {
  const storage = new Storage(dataDbPath(settings), options);
  try {
    return await run(storage);
  } finally {
    storage.close();
  }
}
