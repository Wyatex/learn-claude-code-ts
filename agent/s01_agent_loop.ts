
import OpenAI from "openai";
import type { 
  ChatCompletionMessageParam, 
  ChatCompletionTool 
} from "openai/resources/chat/completions";

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY || "dummy-key",
});

const MODEL = process.env.MODEL_ID || "gpt-4o";
const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`;

// OpenAI 格式的 tools 定义
const TOOLS: ChatCompletionTool[] =[{
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  }
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
async function agentLoop(messages: ChatCompletionMessageParam[]) {
  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: messages,
      tools: TOOLS,
    });

    const responseMessage = response.choices[0].message;
    
    // Append assistant turn (包括可能存在的 tool_calls)
    messages.push(responseMessage);

    const finishReason = response.choices[0].finish_reason;

    // 如果模型没有调用工具（即 finish_reason 不是 tool_calls），则代表当前任务闭环结束
    if (finishReason !== "tool_calls" || !responseMessage.tool_calls) {
      return;
    }

    // Execute each tool call, collect results
    for (const toolCall of responseMessage.tool_calls) {
      if (toolCall.function.name === "bash") {
        // OpenAI 的 arguments 是字符串形式的 JSON，需要解析
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch (e) {
          args = { command: "" }; // Fallback 如果 JSON 损坏
        }
        
        const command = typeof args.command === "string" ? args.command : String(args.command || "");
        
        console.log(`\x1b[33m$ ${command}\x1b[0m`);
        
        const output = await runBash(command);
        console.log(output.substring(0, 200));
        
        // 将工具执行结果作为独立的消息追加
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: output,
        });
      }
    }
  }
}

async function main() {
  // OpenAI 推荐将 System Prompt 作为数组的第一条消息传入
  const history: ChatCompletionMessageParam[] =[
    { role: "system", content: SYSTEM }
  ];
  
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
      // OpenAI 的最后一条消息 content 是单纯的字符串（或 null），不需要遍历 block
      if (lastMessage && lastMessage.role === "assistant" && lastMessage.content) {
        console.log(lastMessage.content);
      }
    } catch (e) {
      console.error("\x1b[31mError during agent loop:\x1b[0m", e);
    }

    console.log();
    process.stdout.write("\x1b[36ms01 >> \x1b[0m");
  }
}

main()