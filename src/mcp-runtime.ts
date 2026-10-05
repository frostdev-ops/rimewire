import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SharedBoardSession } from "./daemon-client.js";
import { createMcpServer } from "./mcp.js";

export async function runMcp(checkout: string, port = 8737): Promise<void> {
  const session = new SharedBoardSession(checkout, port);
  const mcp = createMcpServer(checkout, { boardUrl: () => session.getUrl() });
  let stopping = false;
  await new Promise<void>((done, reject) => {
    const stop = () => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.stdin.off("end", stop);
      process.stdin.off("close", stop);
      void (async () => {
        await session.close();
        await mcp.close();
      })().then(done, reject);
    };
    mcp.server.onclose = stop;
    mcp.server.oninitialized = () => {
      void session
        .getUrl()
        .catch((error: unknown) =>
          process.stderr.write(
            `rimewire: board unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
          ),
        );
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.stdin.once("end", stop);
    process.stdin.once("close", stop);
    void mcp.connect(new StdioServerTransport()).catch((error: unknown) => {
      stop();
      reject(error);
    });
  });
}
