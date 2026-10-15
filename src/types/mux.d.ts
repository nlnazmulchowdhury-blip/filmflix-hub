declare module "mux.js/lib/mp4/transmuxer" {
  export class Transmuxer {
    on(event: "data" | "error" | "done", cb: (seg?: any) => void): void;
    push(bytes: Uint8Array): void;
    flush(): void;
  }
}
