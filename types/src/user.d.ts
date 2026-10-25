export function userOf(u: any): AppUser | null;
export function claimsBehind(entry: {
    v?: any;
} | null | undefined, tokenClaims?: {
    v?: any;
}): boolean;
export type AppUser = {
    uid: string;
    email: string;
    name: string;
    photo: string;
    verified: boolean;
};
