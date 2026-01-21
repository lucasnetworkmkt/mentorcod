
import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/genai";
import { SYSTEM_INSTRUCTION } from "../constants";

// --- CHAVES DE API (CONFIGURAÇÃO DIRETA) ---
// Configuração Hardcoded para garantir funcionamento imediato
const STATIC_KEYS = {
    A: "AIzaSyBX3prHIBxzrfNbExUQSf6-kvdIbiQM3T0", // Chat Texto
    B: "AIzaSyCBOQRta1-O1Uttwkl40umIvVGyHcQHb1g", // Voz
    C: "AIzaSyBNIvn9PFzGA_B3NhDFtalLzORmvNIJpjI"  // Mapas
};

// --- HELPER DE VARIÁVEIS (FALLBACK) ---
const getEnvVar = (key: string): string => {
  let value = '';
  // 1. Process Env (Node/Vercel)
  if (typeof process !== 'undefined' && process.env && process.env[key]) {
    value = process.env[key] as string;
  }
  // 2. Vite Env
  // @ts-ignore
  else if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env[key]) {
    // @ts-ignore
    value = import.meta.env[key];
  }
  return value || '';
};

// --- CONFIGURAÇÃO DOS GRUPOS ---
// Prioridade: Chave Estática (Garantida) -> Variável de Ambiente
const API_GROUPS = {
  // O sistema usará a chave estática primeiro. Se falhar, tenta buscar variáveis.
  A: [STATIC_KEYS.A, getEnvVar('API_KEY_A1'), getEnvVar('API_KEY')].filter(k => k && k.length > 10),
  B: [STATIC_KEYS.B, getEnvVar('API_KEY_B1'), getEnvVar('API_KEY')].filter(k => k && k.length > 10),
  C: [STATIC_KEYS.C, getEnvVar('API_KEY_C1'), getEnvVar('API_KEY')].filter(k => k && k.length > 10)
};

// --- LÓGICA DE CONEXÃO ---
async function executeWithFallback<T>(
  group: 'A' | 'B' | 'C',
  operation: (apiKey: string) => Promise<T>
): Promise<T> {
  const keys = API_GROUPS[group];
  
  if (keys.length === 0) {
    throw new Error("ERRO FATAL: Nenhuma chave de API configurada.");
  }

  // Remove duplicatas
  const uniqueKeys = Array.from(new Set(keys));
  let lastError: any;

  for (const apiKey of uniqueKeys) {
    try {
      return await operation(apiKey);
    } catch (error: any) {
      console.warn(`[Mentor] Falha com chave terminada em ...${apiKey.slice(-4)}:`, error.message);
      lastError = error;
      
      // Se a chave for inválida explicitamente, não adianta tentar de novo a mesma chave, mas o loop tenta a próxima
      const status = error.status || error.response?.status;
      if (status === 403 || error.message?.includes('API key not valid')) {
          console.error("Chave recusada pelo Google. Verifique se a API está ativada no console do Google Cloud.");
      }
    }
  }

  // Mensagem final de erro para o usuário
  let msg = "Sistema Indisponível.";
  if (lastError?.message?.includes('API key')) msg = "Chaves de API Inválidas ou Expiradas.";
  if (lastError?.message?.includes('SAFETY')) msg = "Bloqueio de Segurança (Conteúdo Sensível).";
  
  throw new Error(`${msg} (Detalhe: ${lastError?.message})`);
}

// --- SERVIÇOS PÚBLICOS ---

export const getVoiceApiKey = async (): Promise<string> => {
  // Retorna a primeira chave válida do grupo B
  if (API_GROUPS.B.length > 0) return API_GROUPS.B[0];
  throw new Error("Chave de Voz não encontrada.");
};

export const generateTextResponse = async (history: {role: string, parts: {text: string}[]}[], userMessage: string) => {
  return executeWithFallback('A', async (apiKey) => {
    const ai = new GoogleGenAI({ apiKey });
    
    const validHistory = history.filter(h => h.parts && h.parts[0]?.text);
    const contents = [
      ...validHistory,
      { role: 'user', parts: [{ text: userMessage }] }
    ];

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash', 
      contents: contents,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        maxOutputTokens: 2048,
        temperature: 0.9,
        safetySettings: [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ]
      }
    });

    if (!response.text) {
        if (response.candidates && response.candidates[0]?.finishReason) {
            throw new Error(`Bloqueio de Segurança: ${response.candidates[0].finishReason}`);
        }
        throw new Error("Resposta vazia do modelo.");
    }

    return response.text;
  });
};

export const generateMentalMapStructure = async (topic: string) => {
  return executeWithFallback('C', async (apiKey) => {
    const ai = new GoogleGenAI({ apiKey });

    const prompt = `
      Crie um MAPA MENTAL ESTRUTURADO em formato de ÁRVORE DE TEXTO (ASCII/Tree Style) sobre: "${topic}".
      REGRAS VISUAIS:
      - Use caracteres ASCII para conectar: ├──, └──, │.
      - Não use Markdown code blocks (\`\`\`), apenas o texto puro.
      - Seja hierárquico, direto e focado em EXECUÇÃO.
      - Limite a 3 níveis de profundidade.
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: { parts: [{ text: prompt }] },
      config: {
        safetySettings: [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        ]
      }
    });

    return response.text || "Erro ao gerar mapa.";
  });
};
