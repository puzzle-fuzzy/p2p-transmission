export type Visitor = {
  id: string;
  avatarSeed: string;
  displayName: string;
  token: string;
  createdAt: number;
  lastSeenAt: number;
};

export type PublicVisitor = Omit<Visitor, "token">;

export type VisitorServiceOptions = {
  now?: () => number;
  createId?: () => string;
  createToken?: () => string;
  createAvatarSeed?: () => string;
};
