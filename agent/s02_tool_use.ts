#!/usr/bin/env bun
/**
 * s02_tool_use.ts - Tools
 * 
 * 架构不变，语言从 Python 切换至 TypeScript (Bun)，模型调用从 Anthropic 切换为 OpenAI API。
 */

import OpenAI from "openai";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources";

const execAsync = promisify(exec);

const WORKDIR = process.cwd();
const openai = new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY || "dummy-key",
});
const MODEL = process.env.MODEL_ID || "gpt-4o";

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

function safePath(p: string): string {
    const resolvedPath = path.resolve(WORKDIR, p);
    if (!resolvedPath.startsWith(WORKDIR)) {
        throw new Error(`Path escapes workspace: ${p}`);
    }
    return resolvedPath;
}

async function runBash(command: string): Promise<string> {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some((d) => command.includes(d))) {
        return "Error: Dangerous command blocked";
    }
    try {
        const { stdout, stderr } = await execAsync(command, { 
            cwd: WORKDIR, 
            timeout: 120000 
        });
        const out = (stdout + stderr).trim();
        return out ? out.substring(0, 50000) : "(no output)";
    } catch (e: any) {
        if (e.killed && e.signal === "SIGTERM") {
            return "Error: Timeout (120s)";
        }
        const out = ((e.stdout || "") + (e.stderr || "")).trim();
        return out ? out.substring(0, 50000) : `Error: ${e.message}`;
    }
}

async function runRead(p: string, limit?: number): Promise<string> {
    try {
        const text = await fs.readFile(safePath(p), "utf-8");
        let lines = text.split("\n");
        if (limit && limit < lines.length) {
            lines = lines.slice(0, limit);
            lines.push(`... (${text.split("\n").length - limit} more lines)`);
        }
        return lines.join("\n").substring(0, 50000);
    } catch (e: any) {
        return `Error: ${e.message}`;
    }
}

async function runWrite(p: string, content: string): Promise<string> {
    try {
        const fp = safePath(p);
        await fs.mkdir(path.dirname(fp), { recursive: true });
        await fs.writeFile(fp, content, "utf-8");
        return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${p}`;
    } catch (e: any) {
        return `Error: ${e.message}`;
    }
}

async function runEdit(p: string, oldText: string, newText: string): Promise<string> {
    try {
        const fp = safePath(p);
        const content = await fs.readFile(fp, "utf-8");
        if (!content.includes(oldText)) {
            return `Error: Text not found in ${p}`;
        }
        await fs.writeFile(fp, content.replace(oldText, newText), "utf-8");
        return `Edited ${p}`;
    } catch (e: any) {
        return `Error: ${e.message}`;
    }
}

// -- The dispatch map: {tool_name: handler} --
const TOOL_HANDLERS: Record<string, (args: any) => Promise<string>> = {
    "bash":       (args) => runBash(args.command),
    "read_file":  (args) => runRead(args.path, args.limit),
    "write_file": (args) => runWrite(args.path, args.content),
    "edit_file":  (args) => runEdit(args.path, args.old_text, args.new_text),
};

const TOOLS: ChatCompletionTool[] =[
    {
        type: "function",
        function: {
            name: "bash",
            description: "Run a shell command.",
            parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
        }
    },
    {
        type: "function",
        function: {
            name: "read_file",
            description: "Read file contents.",
            parameters: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] }
        }
    },
    {
        type: "function",
        function: {
            name: "write_file",
            description: "Write content to file.",
            parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required:["path", "content"] }
        }
    },
    {
        type: "function",
        function: {
            name: "edit_file",
            description: "Replace exact text in file.",
            parameters: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required:["path", "old_text", "new_text"] }
        }
    }
];

async function agentLoop(messages: ChatCompletionMessageParam[]) {
    while (true) {
        const response = await openai.chat.completions.create({
            model: MODEL,
            messages:[{ role: "system", content: SYSTEM }, ...messages],
            tools: TOOLS,
        });

        const message = response.choices[0].message;
        messages.push(message as ChatCompletionMessageParam);

        // 如果模型有普通的文字回复，打印出来
        if (message.content) {
            console.log(message.content);
        }

        // 判断是否需要调用工具
        if (response.choices[0].finish_reason !== "tool_calls" || !message.tool_calls) {
            return;
        }

        // 并发或依次处理工具调用结果
        for (const toolCall of message.tool_calls) {
            const args = JSON.parse(toolCall.function.arguments);
            const handler = TOOL_HANDLERS[toolCall.function.name];
            const output = handler ? await handler(args) : `Unknown tool: ${toolCall.function.name}`;
            
            console.log(`> ${toolCall.function.name}: ${output.substring(0, 200).replace(/\n/g, "\\n")}`);
            
            messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: output
            });
        }
    }
}

async function main() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "\x1b[36ms02 >> \x1b[0m"
    });

    const history: ChatCompletionMessageParam[] =[];

    rl.prompt();
    for await (const line of rl) {
        const query = line.trim();
        if (["q", "exit", ""].includes(query.toLowerCase())) {
            break;
        }

        history.push({ role: "user", content: query });
        await agentLoop(history);
        console.log();
        rl.prompt();
    }
    
    rl.close();
}

main().catch(console.error);