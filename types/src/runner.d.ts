/** @param {{ config: Record<string, any>, modules: Module[] }} options */
export function createApp({ config, modules }?: {
    config: Record<string, any>;
    modules: Module[];
}): Record<string, any>;
export type EventUser = {
    uid: string;
    email?: string;
} & Record<string, any>;
export type Ctx = {
    name: string;
    module: string;
    config: Readonly<Record<string, any>>;
    sdk: () => Promise<any>;
    user: () => EventUser | null;
    on: (event: string, fn: (data: any) => any) => () => void;
    emit: (event: string, data?: any) => Promise<string[]>;
    storage: (ns?: string) => {
        name: string;
        get: (key: string) => any;
        set: (key: string, value: any) => void;
        remove: (key: string) => void;
    };
    status: {
        set: (st: ModuleStatus | null) => void;
        get: () => AppStatus;
    };
    report: (fact: Record<string, any>) => void;
    ready: Promise<void>;
};
export type ModuleStatus = {
    state: string;
    count?: number;
    unsent?: number;
};
export type AppStatus = {
    state: string;
    count: number;
    unsent: number;
    parts: Record<string, ModuleStatus>;
};
export type Module = {
    name: string;
    needs?: string[];
    start: (ctx: Ctx, deps: Record<string, any>) => any;
    stop?: () => any;
};
