export type AppMetaEnvironment = Readonly<Record<string, string | undefined>>

const DEVELOPMENT_BUILD = '开发构建'

export const getAppVersion = (environment: AppMetaEnvironment) => {
  const version = environment.VITE_APP_VERSION?.trim()
  return version || DEVELOPMENT_BUILD
}

export const appVersion = getAppVersion(import.meta.env)
