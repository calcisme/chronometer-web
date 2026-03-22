// Allow importing .xml files as text strings (used by esbuild --loader:.xml=text)
declare module '*.xml' {
    const content: string;
    export default content;
}
