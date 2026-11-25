/**
 * E-01: the Canvas 2D renderer, shared by the app's viewport, the embed's 2D
 * stage and anything else that draws a drawing. No store, React or DOM
 * beyond the canvas it is handed.
 */
// Built-in entity kinds (line, arc, insert, hatch...): bounds, culling and tessellation ask the kind registry.
import "../kinds/builtin";

export * from "./view";
export * from "./cull";
export * from "./hatch";
export * from "./entity";
export * from "./scene";
