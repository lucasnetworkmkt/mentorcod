
import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/genai";
import { SYSTEM_INSTRUCTION } from "../constants";

// --- CHAVES DE API (CONFIGURAÇÃO DIRETA) ---
// Configuração Hardcoded para garantir funcionamento imediato
const STATIC_KEYS = {
    A: "AIzaSyBX3prHIBxzrfNbExUQSf6-kvdIbiQM3T0", // Chat Texto (Confirmado funcionando)
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

// --- ESTRATÉGIA DE ROBUSTEZ ---
// Cria um pool com TODAS as chaves válidas encontradas
const ALL_KEYS = [
    STATIC_KEYS.A, STATIC_KEYS.B, STATIC_KEYS.C,
    getEnvVar('API_KEY'), getEnvVar('VITE_API_KEY')
].filter(k => k && k.length > 20);

// --- CONFIGURAÇÃO DOS GRUPOS ---
const API_GROUPS = {
  // Grupo A (Texto): Tenta a chave A, se falhar, tenta qualquer uma do pool
  A: [STATIC_KEYS.A, ...ALL_KEYS],
  
  // Grupo B (Voz): Tenta a chave B, mas se falhar, tenta a A (que sabemos que funciona)
  B: [STATIC_KEYS.B, STATIC_KEYS.A, ...ALL_KEYS],
  
  // Grupo C (Mapas): Tenta a chave C, mas se falhar, tenta a A IMEDIATAMENTE
  C: [STATIC_KEYS.C, STATIC_KEYS.A, ...ALL_KEYS]
};

// --- LÓGICA DE CONEXÃO ---
async function executeWithFallback<T>(
  group: 'A' | 'B' | 'C',
  operation: (apiKey: string) => Promise<T>
): Promise<T> {
  // Remove duplicatas e valores vazios
  const keys = Array.from(new Set(API_GROUPS[group])).filter(Boolean);
  
  if (keys.length === 0) {
    throw new Error("ERRO FATAL: Nenhuma chave de API configurada.");
  }

  let lastError: any;

  for (const apiKey of keys) {
    try {
      // @ts-ignore
      return await operation(apiKey);
    } catch (error: any) {
      console.warn(`[Mentor] Falha com chave ...${apiKey.slice(-4)} no Grupo ${group}:`, error.message);
      lastError = error;
      
      const status = error.status || error.response?.status;
      // Se a chave for explicitamente inválida, continua para a próxima
      if (status === 403 || error.message?.includes('key not valid')) {
          continue;
      }
    }
  }

  // Mensagem final de erro para o usuário
  let msg = "Sistema Indisponível.";
  if (lastError?.message?.includes('API key')) msg = "Todas as chaves falharam.";
  if (lastError?.message?.includes('SAFETY')) msg = "Bloqueio de Segurança.";
  
  throw new Error(`${msg}`);
}

// --- SERVIÇOS PÚBLICOS ---

export const getVoiceApiKey = async (): Promise<string> => {
    // Tenta validar uma chave antes de retornar
    // Como não podemos fazer uma chamada assíncrona dentro da config do Live,
    // retornamos a chave A se a B falhar na lógica de grupos, mas aqui retornamos string direta.
    // Prioridade: B -> A -> Qualquer outra
    const keys = [STATIC_KEYS.B, STATIC_KEYS.A, ...ALL_KEYS].filter(Boolean);
    return keys[0];
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
      
      REGRAS VISUAIS RÍGIDAS:
      1. NÃO use blocos de código markdown (\`\`\`). Retorne APENAS o texto puro.
      2. Use estes conectores exatos: ├──, └──, │.
      3. A estrutura deve ser hierárquica e limpa.
      4. Foco total em AÇÃO e EXECUÇÃO.
      
      Exemplo de Saída Esperada:
      TEMA CENTRAL
      ├── Fase 1: Planejamento
      │   ├── Ação A
      │   └── Ação B
      └── Fase 2: Execução
          └── Ação C
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

    // Clean up markdown blocks if the model puts them anyway
    let text = response.text || "";
    text = text.replace(/```/g, '').trim();
    
    if (!text) throw new Error("Falha na geração do mapa.");
    return text;
  });
};
