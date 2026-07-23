export interface ProxyHandle {
  close(): Promise<void>;
  /** Bound listen port when running in HTTP mode (set after listen). */
  listenPort?: number;
}
