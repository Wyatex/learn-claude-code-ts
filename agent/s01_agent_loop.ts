#!/usr/bin/env bun
/**
 * s01_agent_loop.ts - The Agent Loop
 *
 * The entire secret of an AI coding agent in one pattern:
 *
 *     while (stop_reason === "tool_use") {
 *         response = await LLM(messages, tools)
 *         execute tools
 *         append results
 *     }
 *
 *     +----------+      +-------+      +---------+
 *     |   User   | ---> |  LLM  | ---> |  Tool   |
 *     |  prompt  |      |       |      | execute |
 *     +----------+      +---+---+      +----+----+
 *                           ^               |
 *                           |   tool_result |
 *                           +---------------+
 *                           (loop continues)
 *
 * This is the core loop: feed tool results back to the model
 * until the model decides to stop. Production agents layer
 * policy, hooks, and lifecycle controls on top.
 */

import { Anthropic } from "@anthropic-ai/sdk";
import type { MessageParam, Tool, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";

// Bun natively loads .env files, no dotenv package needed.
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
  apiKey: process.env.ANTHROPIC_API_KEY || "dummy-key",
});

const MODEL = process.env.MODEL_ID as string;
const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`;

const TOOLS: Tool[] =[{
  name: "bash",
  description: "Run a shell command.",
  input_schema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
}];

async function runBash(command: string): Promise<string> {
  const dangerous =["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some(d => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }

  try {
    const proc = Bun.spawn(["bash", "-c", command], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    // Enforce 120s timeout
    const timeoutId = setTimeout(() => proc.kill(), 120000);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    clearTimeout(timeoutId);

    if (proc.killed) {
      return "Error: Timeout (120s)";
    }

    const out = (stdout + stderr).trim();
    return out ? out.substring(0, 50000) : "(no output)";
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

// -- The core pattern: a while loop that calls tools until the model stops --
async function agentLoop(messages: MessageParam[]) {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages,
      tools: TOOLS,
      max_tokens: 8000,
    });

    // Append assistant turn
    messages.push({ role: "assistant", content: response.content });

    // If the model didn't call a tool, we're done
    if (response.stop_reason !== "tool_use") {
      return;
    }

    // Execute each tool call, collect results
    const results: ToolResultBlockParam[] =[];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        // 修复 1: 显式声明类型并提供默认值/类型推断，确保 command 一定是 string
        const input = block.input as Record<string, unknown>;
        const command = typeof input.command === "string" ? input.command : String(input.command || "");
        
        console.log(`\x1b[33m$ ${command}\x1b[0m`);
        
        const output = await runBash(command);
        console.log(output.substring(0, 200));
        
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const history: MessageParam[] =[];
  
  process.stdout.write("\x1b[36ms01 >> \x1b[0m");
  
  // Bun's elegant way to read async lines from stdin
  for await (const line of console) {
    const query = line.trim();
    const lowerQuery = query.toLowerCase();
    
    if (lowerQuery === "q" || lowerQuery === "exit" || lowerQuery === "") {
      break;
    }

    history.push({ role: "user", content: query });
    
    try {
      await agentLoop(history);
      
      // Output the final text reasoning
      const lastMessage = history[history.length - 1];
      // 修复 2: 添加 lastMessage 的判空处理
      if (lastMessage && Array.isArray(lastMessage.content)) {
        for (const block of lastMessage.content) {
          if (block.type === "text") {
            console.log(block.text);
          }
        }
      }
    } catch (e) {
      console.error("\x1b[31mError during agent loop:\x1b[0m", e);
    }

    console.log();
    process.stdout.write("\x1b[36ms01 >> \x1b[0m");
  }
}