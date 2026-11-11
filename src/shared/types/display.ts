export type DisplayInfo = {
  id: number;
  label: string;
  /** The operator's own screen: the one hosting the control window, not the OS's «primary» (a
   *  church may have made the projector its primary display). */
  operator: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
};
