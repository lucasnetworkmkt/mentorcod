
import React, { useEffect, useRef, useState } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { MicOff, Radio, StopCircle, AlertCircle, RefreshCw, Volume2 } from 'lucide-react';
import { getVoiceApiKey } from '../services/geminiService';

const LIVE_VOICE_INSTRUCTION = `
VOCÊ É O MENTOR DO CÓDIGO DA EVOLUÇÃO.
Sua missão é TREINAR o usuário em tempo real.

REGRA DE OURO: RESPONDA A TUDO. INTERAÇÃO TOTAL.
Você não é um assistente passivo que espera comandos claros. Você é um parceiro de conversa ativo.
1. Se o usuário disser "Sim", "Ok" ou "Entendi": Valide imediatamente e dê o próximo passo. Ex: "Ótimo. Agora faça..."
2. Se o usuário hesitar, gaguejar ou ficar em silêncio pensando: Intervenha. Ex: "Fale com clareza. O que está pensando?"
3. Se o usuário desabafar: Escute, mas corte o drama rapidamente e aponte a solução lógica.
4. Nunca deixe o usuário falando sozinho. Cada som que ele emitir merece uma reação sua.

TOM DE VOZ:
- Masculino, Grave, Autoritário e Firme.
- Use frases curtas e de impacto.
- Seja socrático: Responda perguntas com perguntas que façam pensar.
- Não faça discursos longos. O modo voz é um ping-pong rápido.
- Seja firme, mas leal.

Se o áudio estiver ruim ou confuso, diga: "Não entendi. Repita com comando na voz."
`;

const LiveVoice: React.FC = () => {
  const [isActive, setIsActive] = useState(false);
  const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  
  // --- REFS DE INFRAESTRUTURA (CRÍTICO) ---
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  
  // Refs para evitar Garbage Collection
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  
  // Sessão e Controle
  const activeSessionRef = useRef<any>(null);
  const isCleaningUpRef = useRef(false);

  useEffect(() => {
    // Cleanup ao desmontar o componente
    return () => {
        isCleaningUpRef.current = true;
        stopSession(true);
    };
  }, []);

  const stopSession = (force = false) => {
    if (!force && status === 'disconnected') return;
    
    console.log("Encerrando sessão de voz...");

    // 1. Fechar Sessão do Gemini
    if (activeSessionRef.current) {
        try {
            activeSessionRef.current.close();
        } catch (e) { console.warn(e); }
        activeSessionRef.current = null;
    }

    // 2. LIBERAR MICROFONE
    if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => {
            track.stop();
        });
        streamRef.current = null;
    }

    // 3. Desconectar Nós de Áudio
    if (processorRef.current) {
        try { processorRef.current.disconnect(); } catch (e) {}
        processorRef.current = null;
    }
    if (sourceRef.current) {
        try { sourceRef.current.disconnect(); } catch (e) {}
        sourceRef.current = null;
    }

    // 4. Fechar Contextos de Áudio
    if (inputAudioContextRef.current) {
        try { inputAudioContextRef.current.close(); } catch (e) {}
        inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
        try { outputAudioContextRef.current.close(); } catch (e) {}
        outputAudioContextRef.current = null;
    }
    
    // 5. Parar sons
    sourcesRef.current.forEach(source => {
        try { source.stop(); } catch (e) {}
    });
    sourcesRef.current.clear();
    
    if (!isCleaningUpRef.current) {
        setIsActive(false);
        setIsSpeaking(false);
        if (status !== 'error') setStatus('disconnected');
    }
  };

  const startSession = async () => {
    if (status === 'connecting' || isActive) return;

    setErrorMsg('');
    setStatus('connecting');
    isCleaningUpRef.current = false;

    try {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      const inputCtx = new AudioContext({ sampleRate: 16000 });
      const outputCtx = new AudioContext({ sampleRate: 24000 });
      
      // Resume contexts immediately (Browser Requirement)
      await inputCtx.resume();
      await outputCtx.resume();

      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      const apiKey = await getVoiceApiKey();
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
              channelCount: 1,
              sampleRate: 16000,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true
          } 
      });
      streamRef.current = stream;

      const ai = new GoogleGenAI({ apiKey });
      
      // Connect first, THEN setup audio flow
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Fenrir' } },
          },
          systemInstruction: LIVE_VOICE_INSTRUCTION,
        },
        callbacks: {
          onopen: () => {
            console.log("Conexão WebSocket Aberta");
            nextStartTimeRef.current = 0;
            setStatus('connected');
            setIsActive(true);
            
            if (!inputCtx || !streamRef.current) return;

            const source = inputCtx.createMediaStreamSource(streamRef.current);
            // Reduced buffer size (2048) for lower latency and more frequent updates
            const scriptProcessor = inputCtx.createScriptProcessor(2048, 1, 1);
            
            sourceRef.current = source;
            processorRef.current = scriptProcessor;

            scriptProcessor.onaudioprocess = (e) => {
              // OPTIMIZATION: Direct check, no Promise overhead in hot loop
              if (!activeSessionRef.current) return; 

              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlobOptimized(inputData);
              
              try {
                 activeSessionRef.current.sendRealtimeInput({ media: pcmBlob });
              } catch (err) {
                 // Silent fail is okay here, session might be closing
              }
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
             const base64Audio = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
             
             if (base64Audio && outputAudioContextRef.current) {
                setIsSpeaking(true);
                const ctx = outputAudioContextRef.current;
                
                const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
                
                const now = ctx.currentTime;
                if (nextStartTimeRef.current < now) nextStartTimeRef.current = now;
                
                const source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(ctx.destination);
                
                source.addEventListener('ended', () => {
                    sourcesRef.current.delete(source);
                    if (sourcesRef.current.size === 0) setIsSpeaking(false);
                });
                
                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
                sourcesRef.current.add(source);
             }
             
             if (msg.serverContent?.interrupted) {
                 sourcesRef.current.forEach(source => {
                     try { source.stop(); } catch(e){}
                 });
                 sourcesRef.current.clear();
                 nextStartTimeRef.current = 0;
                 setIsSpeaking(false);
             }
          },
          onclose: (e) => {
            console.log("Conexão fechada:", e);
            if (!isCleaningUpRef.current) {
                setStatus('error');
                setErrorMsg("Conexão perdida. Tente novamente.");
                stopSession();
            }
          },
          onerror: (err) => {
            console.error("Erro Live API:", err);
            if (!isCleaningUpRef.current) {
                setStatus('error');
                setErrorMsg("Erro de conexão.");
                stopSession();
            }
          }
        }
      });
      
      const session = await sessionPromise;
      activeSessionRef.current = session;

    } catch (error: any) {
      console.error("Falha no startSession:", error);
      setStatus('error');
      
      let msg = "Erro ao iniciar.";
      if (error.name === 'NotAllowedError') msg = "Microfone bloqueado.";
      
      setErrorMsg(msg);
      stopSession(true);
    }
  };

  // --- Helpers ---
  
  // Optimized Base64 conversion to prevent CPU spikes in audio loop
  function createBlobOptimized(data: Float32Array) {
    const l = data.length;
    // We can use a smaller buffer reuse strategy if needed, but new Int16Array is fast enough
    const int16 = new Int16Array(l);
    for (let i = 0; i < l; i++) {
      // Clamp values [-1, 1]
      let s = data[i];
      if (s > 1) s = 1;
      if (s < -1) s = -1;
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    
    // Efficient binary string construction
    let binary = '';
    const bytes = new Uint8Array(int16.buffer);
    const len = bytes.byteLength;
    
    // Process in chunks to avoid stack overflow with String.fromCharCode.apply
    const CHUNK_SIZE = 8192;
    for (let i = 0; i < len; i += CHUNK_SIZE) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK_SIZE)));
    }
    
    const b64 = btoa(binary);
    return { data: b64, mimeType: 'audio/pcm;rate=16000' };
  }

  function decode(base64: string) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  async function decodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number) {
    const dataInt16 = new Int16Array(data.buffer);
    const frameCount = dataInt16.length / numChannels;
    const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
    for (let channel = 0; channel < numChannels; channel++) {
        const channelData = buffer.getChannelData(channel);
        for (let i = 0; i < frameCount; i++) {
            channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
        }
    }
    return buffer;
  }

  return (
    <div className="flex flex-col items-center justify-center h-full bg-[#0A0A0A] text-white p-4 sm:p-8 relative w-full">
      <div className="max-w-md w-full text-center space-y-8 relative z-10">
        <div>
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tighter text-[#E50914] uppercase mb-2">Comando de Voz Imersivo</h2>
          <p className="text-[#9FB4C7] text-sm sm:text-base">Converse naturalmente. O Mentor está ouvindo.</p>
        </div>

        <div className={`relative w-32 h-32 sm:w-48 sm:h-48 mx-auto flex items-center justify-center rounded-full border-4 transition-all duration-300 
          ${isActive ? (isSpeaking ? 'border-[#E50914] scale-110 shadow-[0_0_80px_rgba(229,9,20,0.6)]' : 'border-[#E50914] shadow-[0_0_50px_rgba(229,9,20,0.3)]') : status === 'error' ? 'border-red-900' : 'border-[#333]'}`}>
           {status === 'connecting' ? (
             <div className="flex flex-col items-center gap-2">
                <RefreshCw className="animate-spin text-[#E50914]" size={32} />
                <span className="text-[10px] text-[#555] font-mono">SINCRONIZANDO...</span>
             </div>
           ) : status === 'error' ? (
             <AlertCircle size={48} className="text-red-700" />
           ) : isActive ? (
             <div className="flex gap-1 items-end h-16">
                {[1,2,3,4,5].map(i => (
                    <div key={i} className={`w-3 bg-[#E50914] animate-pulse`} 
                      style={{
                        height: isSpeaking ? `${Math.random() * 100}%` : '20%', 
                        animationDuration: isSpeaking ? `${0.2 + Math.random() * 0.3}s` : '1.5s'
                      }} 
                    />
                ))}
             </div>
           ) : (
             <MicOff size={48} className="text-[#555]" />
           )}
        </div>

        {status === 'error' && (
           <div className="bg-red-900/20 border border-red-900/50 p-4 rounded-lg animate-in fade-in">
              <p className="text-red-500 font-bold mb-2">{errorMsg}</p>
              <button 
                onClick={startSession}
                className="text-xs text-white uppercase border-b border-[#E50914] hover:text-[#E50914]"
              >
                Tentar Reconectar
              </button>
           </div>
        )}

        <div className="flex justify-center gap-4">
          {!isActive && status !== 'connecting' ? (
            <button 
              onClick={startSession}
              className="bg-[#E50914] hover:bg-red-700 text-white px-8 py-4 rounded-full font-bold uppercase tracking-widest flex items-center gap-3 transition-all shadow-[0_0_20px_rgba(229,9,20,0.3)] disabled:opacity-50 hover:scale-105 active:scale-95 text-sm sm:text-base"
            >
              <Radio size={24} />
              {status === 'error' ? 'Reiniciar Sistema' : 'Iniciar Sessão'}
            </button>
          ) : isActive || status === 'connecting' ? (
            <button 
              onClick={() => stopSession(false)}
              className="bg-[#333] hover:bg-[#222] text-white border border-[#555] px-8 py-4 rounded-full font-bold uppercase tracking-widest flex items-center gap-3 transition-all hover:border-[#E50914] active:scale-95 text-sm sm:text-base"
            >
              <StopCircle size={24} />
              Encerrar
            </button>
          ) : null}
        </div>
        
        {isActive && (
           <div className="space-y-1">
             <p className="text-xs text-[#555] font-mono uppercase">Microfone Ativo</p>
             <p className="text-[10px] text-[#E50914] font-bold uppercase tracking-widest">
               {isSpeaking ? 'O MENTOR ESTÁ FALANDO' : 'AGUARDANDO VOCÊ...'}
             </p>
           </div>
        )}
      </div>
    </div>
  );
};

export default LiveVoice;
