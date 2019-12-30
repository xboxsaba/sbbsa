// DreamTime.
// Copyright (C) DreamNet. All rights reserved.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License 3.0 as published by
// the Free Software Foundation. See <https://www.gnu.org/licenses/gpl-3.0.html>
//
// Written by Ivan Bravo Bravo <ivan@dreamnet.tech>, 2019.

import { startsWith } from 'lodash'
import { app, BrowserWindow, shell } from 'electron'
import { dirname, resolve } from 'path'
import Logger from 'logplease'
import fs from 'fs-extra'
import { AppError } from './modules/app-error'
import { system } from './modules/tools/system'
import { getPath } from './modules/tools/paths'
import { settings, ngrok } from './modules'
import config from '~/nuxt.config'

// logger setup
Logger.setOptions({
  filename: getPath('userData', 'dreamtime.main.log'),
  logLevel: process.env.LOG || 'debug',
})

const logger = Logger.create('electron')

// NuxtJS root directory
config.rootDir = dirname(dirname(__dirname))

if (process.env.name === 'production') {
  // make sure that the working directory is where the executable is
  process.chdir(getPath('exe', '..'))
}

class DreamApp {
  /**
   * @type {BrowserWindow}
   */
  window

  /**
   *
   */
  static async boot() {
    logger.info('Booting...')

    logger.debug(`Enviroment: ${process.env.name}`)
    logger.debug(`App Path: ${app.getAppPath()}`)
    logger.debug(`Exe Path: ${app.getPath('exe')}`)

    // catch errors
    process.on('uncaughtException', (err) => {
      logger.warn('Unhandled exception!', err)
      AppError.handle(err)

      return true
    })

    process.on('unhandledRejection', (err) => {
      logger.warn('Unhandled rejection!', err)
      AppError.handle(err)

      return true
    })

    // https://electronjs.org/docs/tutorial/notifications#windows
    app.setAppUserModelId(process.execPath)

    // https://pracucci.com/electron-slow-background-performances.html
    app.commandLine.appendSwitch('disable-renderer-backgrounding')

    // user settings.
    await settings.boot()

    // this may increase performance on some systems.
    if (settings.app?.disableHardwareAcceleration) {
      logger.debug('Hardware Acceleration disabled.')
      app.disableHardwareAcceleration()
    }
  }

  /**
   * Start the app!
   */
  static async start() {
    logger.info('Starting...')

    await this.setup()

    this.createWindow()
  }

  /**
   * Prepare the application.
   */
  static async setup() {
    if (process.platform === 'darwin') {
      const { enforceMacOSAppLocation } = require('electron-util')

      // https://github.com/sindresorhus/electron-util#enforcemacosapplocation-macos
      enforceMacOSAppLocation()
    }

    // application exit.
    app.on('will-quit', async (event) => {
      logger.debug('Received exit event.')

      event.preventDefault()

      await this.shutdown()

      logger.debug('Bye!')
      app.exit()
    })

    // windows closed, exit.
    app.on('window-all-closed', () => {
      app.quit()
    })

    app.on('web-contents-created', (e, contents) => {
      contents.on('will-navigate', (event, navigationUrl) => {
        const { URL } = require('url')

        const url = new URL(navigationUrl)

        const host = process.env.SERVER_HOST
        const port = process.env.SERVER_PORT

        if (url.host === `${host}:${port}`) {
          // ok
          return
        }

        event.preventDefault()

        logger.warn('Illegal page load blocked!', {
          event,
          url,
        })
      })

      contents.on('new-window', (event, url) => {
        if (startsWith(url, 'http') || startsWith(url, 'mailto')) {
          event.preventDefault()
          shell.openExternal(url)
          return
        }

        logger.debug('Opening new window.', {
          event,
          url,
        })
      })
    })

    const contextMenu = require('electron-context-menu')

    // allow save image option
    contextMenu({
      showSaveImageAs: true,
    })

    // system stats.
    await system.setup()

    // user settings.
    await settings.setup()

    //
    this.createDirs()

    if (process.env.name === 'development') {
      const address = await ngrok.connect()
      logger.debug(`Proxy for debugging: ${address}`)
    }
  }

  /**
   *
   */
  // eslint-disable-next-line no-empty-function
  static async shutdown() {
    logger.debug('Shutting down services...')

    if (process.env.name === 'development') {
      await ngrok.disconnect()
    }
  }

  /**
   * Create the program window and load the interface
   */
  static createWindow() {
    logger.info('Creating window...')

    // browser window.
    this.window = new BrowserWindow({
      width: 1200,
      height: 700,
      minWidth: 1200,
      minHeight: 700,
      frame: false,
      icon: resolve(config.rootDir, 'dist', 'icon.ico'),
      webPreferences: {
        nodeIntegration: true,
        nodeIntegrationInWorker: true,
        preload: resolve(app.getAppPath(), 'electron', 'dist', 'provider.js'),
      },
    })

    // maximize
    // todo: custom preferences
    this.window.maximize()

    // disable menu
    this.window.setMenu(null)

    // ui location
    this.uiUrl = this.getUiUrl()

    if (config.dev) {
      this.pollUi()
    } else {
      this.window.loadFile(this.uiUrl)
    }

    if (process.env.DEVTOOLS) {
      // devtools
      this.window.webContents.openDevTools()
    }
  }

  /**
   * Wait until the NuxtJS server is ready.
   */
  static pollUi() {
    logger.debug(`Requesting server (${this.uiUrl})...`)

    const http = require('http')

    http
      .get(this.uiUrl, (response) => {
        if (response.statusCode === 200) {
          logger.debug('Server ready, dream time!')
          this.window.loadURL(this.uiUrl)
        } else {
          logger.warn(`Server reported: ${response.statusCode}`)
          setTimeout(this.pollUi.bind(this), 300)
        }
      })
      .on('error', (error) => {
        logger.warn('Server error', error)
        setTimeout(this.pollUi.bind(this), 300)
      })
  }

  /**
   * Returns the url of the user interface
   *
   * @return {string}
   */
  static getUiUrl() {
    if (!config.dev) {
      return resolve(config.rootDir, 'dist', 'index.html')
    }

    return `http://localhost:${config.server.port}`
  }

  /**
   * Create required directories.
   */
  static createDirs() {
    const dirs = [
      resolve(settings.folders.models, 'Uncategorized'),
      settings.folders.masks,
    ]

    dirs.forEach((dir) => {
      try {
        fs.ensureDirSync(dir)
      } catch (error) {
        throw new AppError(`Could not create the directory:\n${dir}`, { error })
      }
    })
  }
}

app.on('ready', async () => {
  try {
    await DreamApp.start()
  } catch (error) {
    throw new AppError(error, { title: `Failed to start correctly.`, level: 'error' })
  }
})

DreamApp.boot()
