import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * mateus-toolkit - Extensão que força criação de task pela IA
 * 
 * Usa before_agent_start para injetar mensagem + system prompt forte.
 * USA context para garantir que create_task seja chamado sempre.
 */

interface Task {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  createdAt: number;
}

export default function (pi: ExtensionAPI) {
  let currentTask: Task | null = null;
  let lastUserMessage = "";
  let taskCreationPending = false;

  // Resetar estado na sessão
  pi.on("session_start", async (_event, ctx) => {
    currentTask = null;
    taskCreationPending = false;
    lastUserMessage = "";

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "mateus-toolkit-task") {
        currentTask = entry.data as Task;
        if (currentTask?.status === "completed") {
          currentTask = null;
        }
      }
    }
  });

  // Registrar tool para criar task
  pi.registerTool({
    name: "create_task",
    label: "Create Task",
    description: "Crie uma task para cada ação ou solicitação do usuário. SEMPRE chame esta tool PRIMEIRO.",
    promptSnippet: "create_task: primeira tool obrigatória para CADA mensagem",
    promptGuidelines: [
      "create_task DEVE ser chamada como PRIMEIRA tool em TODA resposta, mesmo para saudações.",
      "NUNCA responda sem antes chamar create_task.",
      "Cada mensagem do usuário = uma nova task.",
    ],
    parameters: Type.Object({
      description: Type.String({ description: "Resumo da solicitação do usuário" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const task: Task = {
        id: Date.now().toString(),
        description: params.description,
        status: "in_progress",
        createdAt: Date.now(),
      };

      currentTask = task;
      taskCreationPending = false;
      pi.appendEntry("mateus-toolkit-task", task);

      return {
        content: [{ type: "text", text: `Task "${task.description}" criada. Prossiga.` }],
        details: { task },
      };
    },
  });

  // Comandos
  pi.registerCommand("tasks", {
    description: "Listar tasks da sessão",
    handler: async (_args, ctx) => {
      const tasks: Task[] = [];
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "custom" && entry.customType === "mateus-toolkit-task") {
          tasks.push(entry.data as Task);
        }
      }
      if (tasks.length === 0) {
        ctx.ui.notify("Nenhuma task", "info");
        return;
      }
      ctx.ui.notify(tasks.map((t, i) => `${i + 1}. [${t.status}] ${t.description}`).join("\n"), "info");
    },
  });

  pi.registerCommand("done", {
    description: "Marcar task como concluída",
    handler: async (_args, ctx) => {
      if (!currentTask) { ctx.ui.notify("Nenhuma task ativa", "warning"); return; }
      currentTask.status = "completed";
      pi.appendEntry("mateus-toolkit-task", { ...currentTask });
      ctx.ui.notify(`Task "${currentTask.description}" concluída!`, "info");
      currentTask = null;
    },
  });

  // Capturar input
  pi.on("input", async (event, ctx) => {
    if (event.text.startsWith("/") || event.source === "extension") {
      return { action: "continue" };
    }
    lastUserMessage = event.text;
    taskCreationPending = true;
    return { action: "continue" };
  });

  // FORÇAR task via before_agent_start - injeta mensagem + system prompt
  pi.on("before_agent_start", async (event, ctx) => {
    // Se já tem task, não fazer nada
    if (currentTask) {
      return {};
    }

    const systemPrompt = ctx.getSystemPrompt();

    return {
      // Injetar mensagem de contexto que força create_task
      message: {
        customType: "mateus-toolkit-forced",
        content: `[SISTEMA] O usuário pediu: "${lastUserMessage.substring(0, 100)}". Você DEVE chamar create_task AGORA como sua primeira ação. Não responda nada além da chamada create_task.`,
        display: false,
      },
      // Reforçar no system prompt
      systemPrompt: systemPrompt + `

[OBRIGATÓRIO: MATEUS-TOOLKIT]
A cada mensagem do usuário, sua PRIMEIRA resposta DEVE conter uma chamada à tool create_task.
NÃO responda com texto antes de chamar create_task.
NÃO chame outras tools antes de create_task.
Se o usuário disse "oi", crie task com descrição "Saudação do usuário".
Se o usuário pediu algo, crie task com descrição resumida.
create_task é OBRIGATÓRIA em 100% dos casos.
[/OBRIGATÓRIO]`,
    };
  });

  // Bloquear tools que não são create_task quando não há task
  pi.on("tool_call", async (event, ctx) => {
    if (currentTask) return; // Task existe, permitir tudo
    if (event.toolName === "create_task") return; // create_task sempre permitido

    // Bloquear qualquer outra tool
    return {
      block: true,
      reason: `BLOQUEADO: Chame create_task PRIMEIRO antes de usar ${event.toolName}.`,
    };
  });

  // Após resposta, verificar se criou task
  pi.on("agent_end", async (event, ctx) => {
    if (!taskCreationPending) return;

    const taskCreated = event.messages.some(
      m => m.role === "toolResult" && m.toolName === "create_task"
    );

    if (taskCreated) {
      taskCreationPending = false;
      return;
    }

    // Não criou - forçar com followUp
    taskCreationPending = false;
    pi.sendUserMessage(
      `Você não criou a task. Chame create_task AGORA com descrição: "${lastUserMessage.substring(0, 80)}"`,
      { deliverAs: "followUp" }
    );
  });

  // Auto-completar task
  pi.on("agent_end", async (event, ctx) => {
    if (currentTask && currentTask.status === "in_progress") {
      const hasActions = event.messages.some(
        m => m.role === "assistant" && m.content?.some(c => c.type === "tool_use")
      );
      if (hasActions) {
        currentTask.status = "completed";
        pi.appendEntry("mateus-toolkit-task", { ...currentTask });
        ctx.ui.notify(`Task "${currentTask.description}" concluída!`, "info");
        currentTask = null;
      }
    }
  });
}
