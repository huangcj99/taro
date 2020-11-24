import * as path from 'path'
import * as fs from 'fs-extra'
import * as mkdirp from 'mkdirp'
import * as md5 from 'md5'
import * as webpack from 'webpack'
import * as SplitChunksPlugin from 'webpack/lib/optimize/SplitChunksPlugin'
import { ConcatSource } from 'webpack-sources'
import { AppConfig, SubPackage } from '@tarojs/taro'
import { resolveMainFilePath, readConfig, promoteRelativePath } from '@tarojs/helper'

const PLUGIN_NAME = 'MiniSplitChunkPlugin'
const SUB_COMMON_DIR = 'sub-common'
const SUB_VENDORS_NAME = 'vendors'
const CSS_MINI_EXTRACT = 'css/mini-extract'

interface DepInfo {
  resource: string
  chunks: Set<string>
}

export default class MiniSplitChunksPlugin extends SplitChunksPlugin {
  options: any
  subCommonDeps: Map<string, DepInfo>
  chunkSubCommons: Map<string, Set<string>>
  subPackagesVendors: webpack.compilation.Chunk[]
  context: string
  distPath: string
  isDevMode: boolean
  subPackages: SubPackage[]
  subRoots: string[]
  subRootRegExps: RegExp[]

  constructor () {
    super()
    this.options = null
    this.subCommonDeps = new Map()
    this.chunkSubCommons = new Map()
    this.subPackagesVendors = []
    this.distPath = ''
  }

  apply (compiler: any) {
    this.context = compiler.context
    this.subPackages = this.getSubpackageConfig(compiler).map((subPackage: SubPackage) => ({
      ...subPackage,
      root: this.formatSubRoot(subPackage.root)
    }))
    this.subRoots = this.subPackages.map((subPackage: SubPackage) => subPackage.root)
    this.subRootRegExps = this.subRoots.map((subRoot: string) => new RegExp(`^${subRoot}/`))
    this.distPath = compiler?.options?.output?.path as string
    this.isDevMode = compiler.options.mode === 'development'

    /**
     * 调用父类SplitChunksPlugin的apply方法，注册相关处理事件
     */
    super.apply(compiler)

    compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation: any) => {
      compilation.hooks.optimizeChunks.tap(PLUGIN_NAME, (chunks: webpack.compilation.Chunk[]) => {
        /**
         * 重置依赖关系
         */
        this.subCommonDeps = new Map()
        this.chunkSubCommons = new Map()
        this.subPackagesVendors = []

        /**
         * 找出分包入口chunks
         */
        const subChunks = chunks.filter(chunk => this.isSubChunk(chunk))

        if (subChunks.length === 0) {
          return
        }

        subChunks.forEach((subChunk: webpack.compilation.Chunk) => {
          const modules: webpack.compilation.Module[] = Array.from(subChunk.modulesIterable)

          modules.map((module: any) => {
            const chunks: webpack.compilation.Chunk[] = Array.from(module.chunksIterable)

            /**
             * 找出没有被主包引用，且被多个分包引用的module，并记录下来
             */
            if (!this.hasMainChunk(chunks) && this.isSubsDep(chunks)) {
              if (!module.resource) {
                return
              }

              if (module.type === CSS_MINI_EXTRACT) {
                return
              }

              const depPath = module.resource.replace(new RegExp(`${this.context}(.*)`), '$1')
              let depName = ''

              if (this.isDevMode) {
                /**
                 * 避免开发模式下，清除sub-common源目录后，触发重新编译时，sub-common目录缺失无变化的chunk导致文件copy失败的问题
                 */
                depName = md5(depPath + new Date().getTime())
              } else {
                depName = md5(depPath)
              }

              if (!this.subCommonDeps.has(depName)) {
                const subCommonDepChunks = new Set(chunks.map(chunk => chunk.name))

                this.subCommonDeps.set(depName, {
                  resource: module.resource,
                  chunks: subCommonDepChunks
                })
              } else {
                const subCommonDep: DepInfo = this.subCommonDeps.get(depName) as DepInfo

                chunks.map(chunk => subCommonDep.chunks.add(chunk.name))
                this.subCommonDeps.set(depName, subCommonDep)
              }
            }
          })
        })

        /**
         * 用新的配置生成options
         */
        this.options = SplitChunksPlugin.normalizeOptions({
          ...compiler?.options?.optimization?.splitChunks,
          cacheGroups: {
            ...compiler?.options?.optimization?.splitChunks?.cacheGroups,
            ...this.getSubPackageVendorsCacheGroup(),
            ...this.getSubCommonCacheGroup()
          }
        })
      })

      /**
       * 收集分包下的vendors和sub-common下的公共模块信息
       */
      compilation.hooks.afterOptimizeChunks.tap(PLUGIN_NAME, (chunks: webpack.compilation.Chunk[]) => {
        const existSubCommonDeps: Map<string, DepInfo> = new Map()

        chunks.forEach(chunk => {
          const chunkName = chunk.name

          if (this.matchSubVendors(chunk)) {
            this.subPackagesVendors.push(chunk)
          }

          if (this.matchSubCommon(chunk)) {
            const depName = chunkName.replace(new RegExp(`^${SUB_COMMON_DIR}/(.*)`), '$1')

            if (this.subCommonDeps.has(depName)) {
              existSubCommonDeps.set(depName, this.subCommonDeps.get(depName) as DepInfo)
            }
          }
        })

        this.setChunkSubCommons(existSubCommonDeps)
        this.subCommonDeps = existSubCommonDeps
      })

      /**
       * 往分包page头部添加require
       */
      compilation.chunkTemplate.hooks.renderWithEntry.tap(PLUGIN_NAME, (modules, chunk) => {
        if (this.isSubChunk(chunk)) {
          const chunkName = chunk.name
          const chunkSubRoot = this.subRoots.find(subRoot => new RegExp(`^${subRoot}/`).test(chunkName))
          const chunkAbsulutePath = path.resolve(this.distPath, chunkName)
          const source = new ConcatSource()
          const subVendors = this.subPackagesVendors.find(subPackagesVendor => {
            return new RegExp(`^${chunkSubRoot}/`).test(subPackagesVendor.name)
          })
          const subCommon = [...(this.chunkSubCommons.get(chunkName) || [])]

          /**
           * require该分包下的vendors
           */
          if (subVendors) {
            const subVendorsAbsolutePath = path.resolve(this.distPath, subVendors.name)
            const relativePath = this.getRealRelativePath(chunkAbsulutePath, subVendorsAbsolutePath)

            source.add(`require(${JSON.stringify(relativePath)});\n`)
          }

          // require sub-common下的模块
          if (subCommon.length > 0) {
            subCommon.forEach(moduleName => {
              const moduleAbsulutePath = path.resolve(this.distPath, chunkSubRoot as string, SUB_COMMON_DIR, moduleName)
              const relativePath = this.getRealRelativePath(chunkAbsulutePath, moduleAbsulutePath)

              source.add(`require(${JSON.stringify(relativePath)});\n`)
            })
          }

          source.add('\n')
          source.add(modules)
          source.add(';')
          return source
        }
      })
    })

    compiler.hooks.afterEmit.tap(PLUGIN_NAME, () => {
      const subCommonPath = path.resolve(this.distPath, SUB_COMMON_DIR)

      if (!fs.pathExistsSync(subCommonPath)) {
        return
      }

      this.subCommonDeps.forEach((subCommonDep, depName) => {
        const depFileName = depName + '.js'
        const depJsMapFileName = depName + '.js.map'
        const sourcePath = path.resolve(subCommonPath, depFileName)
        const mapSourcePath = path.resolve(subCommonPath, depJsMapFileName)
        const chunks = [...subCommonDep.chunks]
        const needCopySubRoots: Set<string> = chunks.reduce((set: Set<any>, chunkName: string) => {
          const subRoot = this.subRoots.find(subRoot => new RegExp(`^${subRoot}/`).test(chunkName))

          set.add(subRoot)
          return set
        }, new Set())

        /**
         * sub-common下模块copy到对应分包路径下：分包/sub-common
         */
        needCopySubRoots.forEach(needCopySubRoot => {
          const targetDirPath = path.resolve(this.distPath, needCopySubRoot, SUB_COMMON_DIR)
          const sourceTargetPath = path.resolve(targetDirPath, depFileName)
          const mapSourceTargetPath = path.resolve(targetDirPath, depJsMapFileName)

          /**
           * 检查是否存在目录，没有则创建
           */
          mkdirp.sync(targetDirPath)

          if (fs.pathExistsSync(sourcePath)) {
            fs.outputFileSync(sourceTargetPath, fs.readFileSync(sourcePath))
          }

          if (fs.pathExistsSync(mapSourcePath)) {
            fs.outputFileSync(mapSourceTargetPath, fs.readFileSync(mapSourcePath))
          }
        })
      })

      /**
       * 复制完成后清理根目录的sub-common
       */
      fs.emptyDirSync(subCommonPath)
      fs.removeSync(subCommonPath)
    })
  }

  /**
   * 根据 webpack entry 配置获取入口文件路径
   */
  getAppEntry (compiler: webpack.Compiler): string {
    const originalEntry = compiler.options.entry as webpack.Entry

    return path.resolve(this.context, originalEntry.app[0])
  }

  /**
   * 获取分包配置
   */
  getSubpackageConfig (compiler: webpack.Compiler): SubPackage[] {
    const appEntry = this.getAppEntry(compiler)
    const appConfigPath = this.getConfigFilePath(appEntry)
    const appConfig: AppConfig = readConfig(appConfigPath)

    return appConfig.subPackages || appConfig.subpackages || []
  }

  /**
   * 根据 app、页面、组件的路径获取对应的 config 配置文件的路径
   */
  getConfigFilePath (filePath: string): string {
    return resolveMainFilePath(`${filePath.replace(path.extname(filePath), '')}.config`)
  }

  /**
   * 去掉尾部的/
   */
  formatSubRoot (subRoot: string): string {
    const lastApl = subRoot[subRoot.length - 1]

    if (lastApl === '/') {
      subRoot = subRoot.slice(0, subRoot.length - 1)
    }
    return subRoot
  }

  isSubChunk (chunk: webpack.compilation.Chunk): boolean {
    const isSubChunk = this.subRootRegExps.find(subRootRegExp => subRootRegExp.test(chunk.name))

    return !!isSubChunk
  }

  /**
   * match *\/vendors
   */
  matchSubVendors (chunk: webpack.compilation.Chunk): boolean {
    const subVendorsRegExps = this.subRoots.map(subRoot => new RegExp(`^${path.join(subRoot, SUB_VENDORS_NAME)}$`))
    const isSubVendors = subVendorsRegExps.find(subVendorsRegExp => subVendorsRegExp.test(chunk.name))

    return !!isSubVendors
  }

  /**
   * match sub-common\/*
   */
  matchSubCommon (chunk: webpack.compilation.Chunk): boolean {
    return new RegExp(`^${SUB_COMMON_DIR}/`).test(chunk.name)
  }

  /**
   * 判断module有没被主包引用
   */
  hasMainChunk (chunks: webpack.compilation.Chunk[]): boolean {
    const chunkNames: string[] = chunks.map(chunk => chunk.name)
    let hasMainChunk = false

    /**
     * 遍历chunk，如果其中有一个chunk，无法匹配分包root，则视为非分包的chunk
     */
    chunkNames.forEach((chunkName: string) => {
      const isMatch: RegExp | undefined = this.subRootRegExps.find(subRootRegExp => subRootRegExp.test(chunkName))

      if (!isMatch) {
        hasMainChunk = true
      }
    })
    return hasMainChunk
  }

  /**
   * 判断该module有没被多个分包引用
   */
  isSubsDep (chunks: webpack.compilation.Chunk[]): boolean {
    const chunkNames: string[] = chunks.map(chunk => chunk.name)
    const chunkSubRoots: Set<string> = new Set()

    chunkNames.forEach((chunkName: string) => {
      this.subRoots.forEach((subRoot: string) => {
        if (new RegExp(`^${subRoot}/`).test(chunkName)) {
          chunkSubRoots.add(subRoot)
        }
      })
    })
    return [...chunkSubRoots].length > 1
  }

  /**
   * 仅分包有引用的module抽取到分包下的vendors
   */
  getSubPackageVendorsCacheGroup () {
    const subPackageVendorsCacheGroup = {}

    this.subRoots.forEach(subRoot => {
      subPackageVendorsCacheGroup[subRoot] = {
        test: (module, chunks) => {
          if (module.type === CSS_MINI_EXTRACT) {
            return false
          }

          return chunks.every(chunk => new RegExp(`^${subRoot}/`).test(chunk.name))
        },
        name: `${subRoot}/${SUB_VENDORS_NAME}`,
        minChunks: 2,
        priority: 10000
      }
    })
    return subPackageVendorsCacheGroup
  }

  /**
   * 没有被主包引用， 且被多个分包引用， 提取成单个模块，输出到sub-common下
   */
  getSubCommonCacheGroup () {
    const subCommonCacheGroup = {}

    this.subCommonDeps.forEach((depInfo: DepInfo, depName: string) => {
      subCommonCacheGroup[`${SUB_COMMON_DIR}/${depName}`] = {
        name: `${SUB_COMMON_DIR}/${depName}`,
        test: module => {
          return module.resource === depInfo.resource
        },
        priority: 1000
      }
    })
    return subCommonCacheGroup
  }

  setChunkSubCommons (subCommonDeps: Map<string, DepInfo>) {
    const chunkSubCommons: Map<string, Set<string>> = new Map()

    subCommonDeps.forEach((depInfo: DepInfo, depName: string) => {
      const chunks: string[] = [...depInfo.chunks]

      chunks.forEach(chunk => {
        if (chunkSubCommons.has(chunk)) {
          const chunkSubCommon = chunkSubCommons.get(chunk) as Set<string>

          chunkSubCommon.add(depName)
          chunkSubCommons.set(chunk, chunkSubCommon)
        } else {
          chunkSubCommons.set(chunk, new Set([depName]))
        }
      })
    })
    this.chunkSubCommons = chunkSubCommons
  }

  /**
   * 获取page相对于公共模块的路径
   */
  getRealRelativePath (from: string, to: string): string {
    return promoteRelativePath(path.relative(from, to))
  }
}
