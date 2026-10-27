import { z } from "zod";

export const spaceCodeSchema = z
  .string()
  .regex(/^[0-9]{1,100}$/, "Enter between 1 and 100 digits.");
