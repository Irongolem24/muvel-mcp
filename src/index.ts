#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MuvelClient } from "./client.js";
import { primeApp } from "./live.js";
import { registerTools } from "./tools.js";

const readOnly = process.env.MUVEL_READ_ONLY === "1";

const server = new McpServer(
  { name: "muvel-mcp", version: "0.1.0" },
  {
    instructions: [
      "Muvel(muvel.app) 클라우드 소설을 읽고 쓰는 도구입니다.",
      "작업 순서: muvel_list_novels → muvel_get_novel로 회차·위키 목록 파악 → 필요한 회차/위키 읽기.",
      "본문은 '한 줄 = 한 블록(문단)' 형식입니다.",
      "본문 수정은 가능하면 muvel_edit_episode(부분 수정)를 쓰고, 전체 교체 시에는 읽을 때 받은 contentVersion을 expectedVersion으로 넘기세요.",
      "평가·피드백은 본문을 고치지 말고 muvel_add_comment나 muvel_create_memo로 남기는 것을 우선하세요.",
      readOnly ? "현재 읽기 전용 모드입니다(MUVEL_READ_ONLY=1)." : "",
    ]
      .filter(Boolean)
      .join("\n"),
  },
);

registerTools(server, new MuvelClient(), { readOnly });
await server.connect(new StdioServerTransport());
void primeApp();
