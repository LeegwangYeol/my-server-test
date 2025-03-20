import { RealtimeEventHandler } from "./event_handler";
import { RealtimeAPI } from "./api";
import { RealtimeConversation } from "./conversation";
import { RealtimeUtils } from "./utils";

/**
 * Valid audio formats
 */
type AudioFormatType = "pcm16" | "g711_ulaw" | "g711_alaw";

/**
 * Audio Transcription Type
 */
interface AudioTranscriptionType {
  model: "whisper-1";
}

/**
 * Turn Detection Server VAD Type
 */
interface TurnDetectionServerVadType {
  type: "server_vad";
  threshold?: number;
  prefix_padding_ms?: number;
  silence_duration_ms?: number;
}

/**
 * Tool definitions
 */
interface ToolDefinitionType {
  type?: "function";
  name: string;
  description: string;
  parameters: { [key: string]: any };
}

/**
 * Session Resource Type
 */
interface SessionResourceType {
  model?: string;
  modalities?: string[];
  instructions?: string;
  voice?:
    | "alloy"
    | "ash"
    | "ballad"
    | "coral"
    | "echo"
    | "sage"
    | "shimmer"
    | "verse";
  input_audio_format?: AudioFormatType;
  output_audio_format?: AudioFormatType;
  input_audio_transcription?: AudioTranscriptionType | null;
  turn_detection?: TurnDetectionServerVadType | null;
  tools?: ToolDefinitionType[];
  tool_choice?:
    | "auto"
    | "none"
    | "required"
    | { type: "function"; name: string };
  temperature?: number;
  max_response_output_tokens?: number | "inf";
}

/**
 * Item Status Type
 */
type ItemStatusType = "in_progress" | "completed" | "incomplete";

/**
 * Input Text Content Type
 */
interface InputTextContentType {
  type: "input_text";
  text: string;
}

/**
 * Input Audio Content Type
 */
interface InputAudioContentType {
  type: "input_audio";
  audio?: string; // base64-encoded audio data
  transcript?: string | null;
}

/**
 * Text Content Type
 */
interface TextContentType {
  type: "text";
  text: string;
}

/**
 * Audio Content Type
 */
interface AudioContentType {
  type: "audio";
  audio?: string; // base64-encoded audio data
  transcript?: string | null;
}

/**
 * System Item Type
 */
interface SystemItemType {
  previous_item_id?: string | null;
  type: "message";
  status: ItemStatusType;
  role: "system";
  content: InputTextContentType[];
}

/**
 * User Item Type
 */
interface UserItemType {
  previous_item_id?: string | null;
  type: "message";
  status: ItemStatusType;
  role: "user";
  content: (InputTextContentType | InputAudioContentType)[];
}

/**
 * Assistant Item Type
 */
interface AssistantItemType {
  previous_item_id?: string | null;
  type: "message";
  status: ItemStatusType;
  role: "assistant";
  content: (TextContentType | AudioContentType)[];
}

/**
 * Function Call Item Type
 */
interface FunctionCallItemType {
  previous_item_id?: string | null;
  type: "function_call";
  status: ItemStatusType;
  call_id: string;
  name: string;
  arguments: string;
}

/**
 * Function Call Output Item Type
 */
interface FunctionCallOutputItemType {
  previous_item_id?: string | null;
  type: "function_call_output";
  call_id: string;
  output: string;
}

/**
 * Formatted Tool Type
 */
interface FormattedToolType {
  type: "function";
  name: string;
  call_id: string;
  arguments: string;
}

/**
 * Formatted Property Type
 */
interface FormattedPropertyType {
  audio?: Int16Array;
  text?: string;
  transcript?: string;
  tool?: FormattedToolType;
  output?: string;
  file?: any;
}

/**
 * Formatted Item Type
 */
interface FormattedItemType {
  id: string;
  object: string;
  role?: "user" | "assistant" | "system";
  formatted: FormattedPropertyType;
}

/**
 * Base Item Type
 */
type BaseItemType =
  | SystemItemType
  | UserItemType
  | AssistantItemType
  | FunctionCallItemType
  | FunctionCallOutputItemType;

/**
 * Item Type
 */
export type ItemType = FormattedItemType & BaseItemType;

/**
 * Incomplete Response Status Type
 */
interface IncompleteResponseStatusType {
  type: "incomplete";
  reason: "interruption" | "max_output_tokens" | "content_filter";
}

/**
 * Failed Response Status Type
 */
interface FailedResponseStatusType {
  type: "failed";
  error: { code: string; message: string } | null;
}

/**
 * Usage Type
 */
interface UsageType {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
}

/**
 * Response Resource Type
 */
interface ResponseResourceType {
  status: "in_progress" | "completed" | "incomplete" | "cancelled" | "failed";
  status_details:
    | IncompleteResponseStatusType
    | FailedResponseStatusType
    | null;
  output: ItemType[];
  usage: UsageType | null;
}

/**
 * RealtimeClient Class
 */
export class RealtimeClient extends RealtimeEventHandler {
  defaultSessionConfig: SessionResourceType;
  sessionConfig: SessionResourceType;
  transcriptionModels: AudioTranscriptionType[];
  defaultServerVadConfig: TurnDetectionServerVadType;
  realtime: RealtimeAPI;
  conversation: RealtimeConversation;
  sessionCreated: boolean = false;
  tools: {
    [name: string]: { definition: ToolDefinitionType; handler: Function };
  } = {};
  inputAudioBuffer: Int16Array = new Int16Array(0);

  constructor({
    url,
    apiKey,
    dangerouslyAllowAPIKeyInBrowser,
    debug,
  }: {
    url?: string;
    apiKey?: string;
    dangerouslyAllowAPIKeyInBrowser?: boolean;
    debug?: boolean;
  } = {}) {
    super();
    this.defaultSessionConfig = {
      modalities: ["text", "audio"],
      instructions: "",
      voice: "verse",
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      input_audio_transcription: null,
      turn_detection: null,
      tools: [],
      tool_choice: "auto",
      temperature: 0.8,
      max_response_output_tokens: 4096,
    };
    this.sessionConfig = {};
    this.transcriptionModels = [
      {
        model: "whisper-1",
      },
    ];
    this.defaultServerVadConfig = {
      type: "server_vad",
      threshold: 0.5, // 0.0 to 1.0,
      prefix_padding_ms: 300, // How much audio to include in the audio stream before the speech starts.
      silence_duration_ms: 200, // How long to wait to mark the speech as stopped.
    };
    this.realtime = new RealtimeAPI({
      url,
      apiKey,
      dangerouslyAllowAPIKeyInBrowser,
      debug,
    });
    this.conversation = new RealtimeConversation();
    this._resetConfig();
    this._addAPIEventHandlers();
  }

  /**
   * Resets sessionConfig and conversationConfig to default
   * @private
   * @returns {true}
   */
  private _resetConfig(): true {
    this.sessionCreated = false;
    this.tools = {};
    this.sessionConfig = JSON.parse(JSON.stringify(this.defaultSessionConfig));
    this.inputAudioBuffer = new Int16Array(0);
    return true;
  }

  /**
   * Sets up event handlers for a fully-functional application control flow
   * @private
   * @returns {true}
   */
  private _addAPIEventHandlers(): true {
    // Event Logging handlers
    this.realtime.on("client.*", (event) => {
      const realtimeEvent = {
        time: new Date().toISOString(),
        source: "client",
        event: event,
      };
      this.dispatch("realtime.event", realtimeEvent);
    });
    this.realtime.on("server.*", (event) => {
      const realtimeEvent = {
        time: new Date().toISOString(),
        source: "server",
        event: event,
      };
      this.dispatch("realtime.event", realtimeEvent);
    });

    // Handles session created event, can optionally wait for it
    this.realtime.on(
      "server.session.created",
      () => (this.sessionCreated = true),
    );

    // Setup for application control flow
    const handler = (event: any, ...args: any[]) => {
      const { item, delta } = this.conversation.processEvent(event, ...args);
      return { item, delta };
    };
    const handlerWithDispatch = (event: any, ...args: any[]) => {
      const { item, delta } = handler(event, ...args);
      if (item) {
        // FIXME: If statement is only here because item.input_audio_transcription.completed
        //        can fire before `item.created`, resulting in empty item.
        //        This happens in VAD mode with empty audio
        this.dispatch("conversation.updated", { item, delta });
      }
      return { item, delta };
    };
    const callTool = async (tool: FormattedToolType) => {
      try {
        const jsonArguments = JSON.parse(tool.arguments);
        const toolConfig = this.tools[tool.name];
        if (!toolConfig) {
          throw new Error(`Tool "${tool.name}" has not been added`);
        }
        const result = await toolConfig.handler(jsonArguments);
        this.realtime.send("conversation.item.create", {
          item: {
            type: "function_call_output",
            call_id: tool.call_id,
            output: JSON.stringify(result),
          },
        });
      } catch (e: any) {
        this.realtime.send("conversation.item.create", {
          item: {
            type: "function_call_output",
            call_id: tool.call_id,
            output: JSON.stringify({ error: e.message }),
          },
        });
      }
      this.createResponse();
    };

    // Handlers to update internal conversation state
    this.realtime.on("server.response.created", handler);
    this.realtime.on("server.response.output_item.added", handler);
    this.realtime.on("server.response.content_part.added", handler);
    this.realtime.on("server.input_audio_buffer.speech_started", (event) => {
      handler(event);
      this.dispatch("conversation.interrupted");
    });
    this.realtime.on("server.input_audio_buffer.speech_stopped", (event) =>
      handler(event, this.inputAudioBuffer),
    );

    // Handlers to update application state
    this.realtime.on("server.conversation.item.created", (event) => {
      const { item } = handlerWithDispatch(event);
      this.dispatch("conversation.item.appended", { item });
      if (item.status === "completed") {
        this.dispatch("conversation.item.completed", { item });
      }
    });
    this.realtime.on("server.conversation.item.truncated", handlerWithDispatch);
    this.realtime.on("server.conversation.item.deleted", handlerWithDispatch);
    this.realtime.on(
      "server.conversation.item.input_audio_transcription.completed",
      handlerWithDispatch,
    );
    this.realtime.on(
      "server.response.audio_transcript.delta",
      handlerWithDispatch,
    );
    this.realtime.on("server.response.audio.delta", handlerWithDispatch);
    this.realtime.on("server.response.text.delta", handlerWithDispatch);
    this.realtime.on(
      "server.response.function_call_arguments.delta",
      handlerWithDispatch,
    );
    this.realtime.on("server.response.output_item.done", async (event) => {
      const { item } = handlerWithDispatch(event);
      if (item.status === "completed") {
        this.dispatch("conversation.item.completed", { item });
      }
      const tool = item.formatted.tool;
      if (tool && this.tools[tool.name]?.handler) {
        callTool(item.formatted.tool);
      }
    });

    return true;
  }

  /**
   * Tells us whether the realtime socket is connected and the session has started
   * @returns {boolean}
   */
  isConnected(): boolean {
    return this.realtime.isConnected();
  }

  /**
   * Resets the client instance entirely: disconnects and clears active config
   * @returns {true}
   */
  reset(): true {
    this.disconnect();
    this.clearEventHandlers();
    this.realtime.clearEventHandlers();
    this._resetConfig();
    this._addAPIEventHandlers();
    return true;
  }

  /**
   * Connects to the Realtime WebSocket API
   * Updates session config and conversation config
   * @returns {Promise<true>}
   */
  async connect(): Promise<true> {
    if (this.isConnected()) {
      throw new Error(`Already connected, use .disconnect() first`);
    }
    await this.realtime.connect();
    this.updateSession();
    return true;
  }

  /**
   * Waits for a session.created event to be executed before proceeding
   * @returns {Promise<true>}
   */
  async waitForSessionCreated(): Promise<true> {
    if (!this.isConnected()) {
      throw new Error(`Not connected, use .connect() first`);
    }
    while (!this.sessionCreated) {
      await new Promise((r) => setTimeout(() => r(true), 1));
    }
    return true;
  }

  /**
   * Disconnects from the Realtime API and clears the conversation history
   */
  disconnect() {
    this.sessionCreated = false;
    this.realtime.isConnected() && this.realtime.disconnect();
    this.conversation.clear();
  }

  /**
   * Gets the active turn detection mode
   * @returns {"server_vad"|null}
   */
  getTurnDetectionType(): "server_vad" | null {
    return (this.sessionConfig.turn_detection?.type as "server_vad") || null;
  }

  /**
   * Add a tool and handler
   * @param {ToolDefinitionType} definition
   * @param {function} handler
   * @returns {{definition: ToolDefinitionType, handler: Function}}
   */
  addTool(
    definition: ToolDefinitionType,
    handler: Function,
  ): { definition: ToolDefinitionType; handler: Function } {
    if (!definition?.name) {
      throw new Error(`Missing tool name in definition`);
    }
    const name = definition?.name;
    if (this.tools[name]) {
      throw new Error(
        `Tool "${name}" already added. Please use .removeTool("${name}") before trying to add again.`,
      );
    }
    if (typeof handler !== "function") {
      throw new Error(`Tool "${name}" handler must be a function`);
    }
    this.tools[name] = { definition, handler };
    this.updateSession();
    return this.tools[name];
  }

  /**
   * Removes a tool
   * @param {string} name
   * @returns {true}
   */
  removeTool(name: string): true {
    if (!this.tools[name]) {
      throw new Error(`Tool "${name}" does not exist, can not be removed.`);
    }
    delete this.tools[name];
    return true;
  }

  /**
   * Deletes an item
   * @param {string} id
   * @returns {true}
   */
  deleteItem(id: string): true {
    this.realtime.send("conversation.item.delete", { item_id: id });
    return true;
  }

  /**
   * Updates session configuration
   * If the client is not yet connected, will save details and instantiate upon connection
   * @param {SessionResourceType} [sessionConfig]
   */
  updateSession(sessionConfig: SessionResourceType = {}): true {
    const {
      modalities = undefined,
      instructions = undefined,
      voice = undefined,
      input_audio_format = undefined,
      output_audio_format = undefined,
      input_audio_transcription = undefined,
      turn_detection = undefined,
      tools = undefined,
      tool_choice = undefined,
      temperature = undefined,
      max_response_output_tokens = undefined,
    } = sessionConfig;
    modalities !== undefined && (this.sessionConfig.modalities = modalities);
    instructions !== undefined &&
      (this.sessionConfig.instructions = instructions);
    voice !== undefined && (this.sessionConfig.voice = voice);
    input_audio_format !== undefined &&
      (this.sessionConfig.input_audio_format = input_audio_format);
    output_audio_format !== undefined &&
      (this.sessionConfig.output_audio_format = output_audio_format);
    input_audio_transcription !== undefined &&
      (this.sessionConfig.input_audio_transcription =
        input_audio_transcription);
    turn_detection !== undefined &&
      (this.sessionConfig.turn_detection = turn_detection);
    tools !== undefined && (this.sessionConfig.tools = tools);
    tool_choice !== undefined && (this.sessionConfig.tool_choice = tool_choice);
    temperature !== undefined && (this.sessionConfig.temperature = temperature);
    max_response_output_tokens !== undefined &&
      (this.sessionConfig.max_response_output_tokens =
        max_response_output_tokens);
    // Load tools from tool definitions + already loaded tools
    const useTools = ([] as ToolDefinitionType[]).concat(
      (tools || ([] as any)).map((toolDefinition: any) => {
        const definition = {
          type: "function",
          ...toolDefinition,
        };
        if (this.tools[definition?.name]) {
          throw new Error(
            `Tool "${definition?.name}" has already been defined`,
          );
        }
        return definition;
      }),
      Object.keys(this.tools).map((key) => {
        return {
          type: "function",
          ...this.tools[key].definition,
        };
      }),
    );
    const session = { ...this.sessionConfig };
    session.tools = useTools;
    if (this.realtime.isConnected()) {
      this.realtime.send("session.update", { session });
    }
    return true;
  }

  /**
   * Sends user message content and generates a response
   * @param {Array<InputTextContentType|InputAudioContentType>} content
   * @returns {true}
   */
  sendUserMessageContent(
    content: (InputTextContentType | InputAudioContentType)[] = [],
  ): true {
    if (content.length) {
      for (const c of content) {
        if (c.type === "input_audio") {
          const audio = c.audio as any;
          if (audio instanceof ArrayBuffer || audio instanceof Int16Array) {
            c.audio = RealtimeUtils.arrayBufferToBase64(audio);
          }
        }
      }
      this.realtime.send("conversation.item.create", {
        item: {
          type: "message",
          role: "user",
          content,
        },
      });
    }
    this.createResponse();
    return true;
  }

  /**
   * Appends user audio to the existing audio buffer
   * @param {Int16Array|ArrayBuffer} arrayBuffer
   * @returns {true}
   */
  appendInputAudio(arrayBuffer: Int16Array | ArrayBuffer): true {
    if (arrayBuffer.byteLength > 0) {
      this.realtime.send("input_audio_buffer.append", {
        audio: RealtimeUtils.arrayBufferToBase64(arrayBuffer),
      });
      this.inputAudioBuffer = RealtimeUtils.mergeInt16Arrays(
        this.inputAudioBuffer,
        arrayBuffer,
      );
    }
    return true;
  }

  /**
   * Forces a model response generation
   * @returns {true}
   */
  createResponse(): true {
    if (
      this.getTurnDetectionType() === null &&
      this.inputAudioBuffer.byteLength > 0
    ) {
      this.realtime.send("input_audio_buffer.commit");
      this.conversation.queueInputAudio(this.inputAudioBuffer);
      this.inputAudioBuffer = new Int16Array(0);
    }
    this.realtime.send("response.create");
    return true;
  }

  /**
   * Cancels the ongoing server generation and truncates ongoing generation, if applicable
   * If no id provided, will simply call `cancel_generation` command
   * @param {string} id The id of the message to cancel
   * @param {number} [sampleCount] The number of samples to truncate past for the ongoing generation
   * @returns {{item: AssistantItemType | null}}
   */
  cancelResponse(
    id: string,
    sampleCount = 0,
  ): { item: AssistantItemType | null } | undefined {
    if (!id) {
      this.realtime.send("response.cancel");
      return { item: null };
    } else if (id) {
      const item = this.conversation.getItem(id);
      if (!item) {
        throw new Error(`Could not find item "${id}"`);
      }
      if (item.type !== "message") {
        throw new Error(`Can only cancelResponse messages with type "message"`);
      } else if (item.role !== "assistant") {
        throw new Error(
          `Can only cancelResponse messages with role "assistant"`,
        );
      }
      this.realtime.send("response.cancel");
      const audioIndex = item.content.findIndex((c: any) => c.type === "audio");
      if (audioIndex === -1) {
        throw new Error(`Could not find audio on item to cancel`);
      }
      this.realtime.send("conversation.item.truncate", {
        item_id: id,
        content_index: audioIndex,
        audio_end_ms: Math.floor(
          (sampleCount / this.conversation.defaultFrequency) * 1000,
        ),
      });
      return { item: item as AssistantItemType };
    }
  }

  /**
   * Utility for waiting for the next `conversation.item.appended` event to be triggered by the server
   * @returns {Promise<{item: ItemType}>}
   */
  async waitForNextItem(): Promise<{ item: ItemType }> {
    const event = await this.waitForNext("conversation.item.appended");
    return { item: event?.item };
  }

  /**
   * Utility for waiting for the next `conversation.item.completed` event to be triggered by the server
   * @returns {Promise<{item: ItemType}>}
   */
  async waitForNextCompletedItem(): Promise<{ item: ItemType }> {
    const event = await this.waitForNext("conversation.item.completed");
    return { item: event?.item };
  }
}
