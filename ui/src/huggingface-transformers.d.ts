declare module '@huggingface/transformers' {
  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ): Promise<
    (
      text: string,
      options?: Record<string, unknown>,
    ) => Promise<Array<{ generated_text: string }>>
  >;
}
