/**
 * This is the script that generates JSON and YAML files
 */

const CLI = require('./cli')
const prettyPrintSize = require('./prettyPrintSize')
const fs = require('fs')
const minifier = require('luamin').minify
const elementTypes = require('./elementTypes')
const { inflate } = require('zlib')
const { match } = require('assert')
const helperEvents = fs.readFileSync(`${ __dirname }/lua/Events.lua`).toString()
const helperLinking = fs.readFileSync(`${ __dirname }/lua/AutoConfig.lua`).toString()
const helperCompressed = fs.readFileSync(`${ __dirname }/lua/Compressed.lua`).toString()
const regexMinifiedExportComment = /;?__EXPORT_VARIABLE=\[\[{(.*?)}{(.*?)}{(.*?)}\]\];?/g
const regexPlainExportCommentWithVariable = /(.*?)\s*?=\s*?(.*?)\s*?\-\-export\:?(.*)?/g
const internalTypes = {
  library: {
    slotId: -3,
    events: [],
  },
  system: {
    slotId: -2,
    events: [
      { signature: 'actionStart(action)' },
      { signature: 'actionLoop(action)' },
      { signature: 'actionStop(action)' },
      { signature: 'update()' },
      { signature: 'flush()' },
      { signature: 'inputText(text)' },
    ]
  },
  control: {
    slotId: -1,
    events: [
      { signature: 'start()' },
      { signature: 'stop()' },
      { signature: 'tick(timerId)' },
    ],
  },
}

function deMinifyExport (line) {
  return ~line.indexOf('__EXPORT_VARIABLE=')
    ? line.replace(regexMinifiedExportComment, (match, varName, varDefault, varComment) => `\n${ varName }=${ varDefault } --export${ (varComment || '').length > 1 ? `: ${ varComment }` : '' }\n`)
    : line
}

function runMinifier(source) {
  return minifier(source)
    .replace(/\r/gi, '')
    .replace(/[\n\s]{2,}/gi, ' ')
}

function runCompression(source) {
  // The initial version
  const initialLua = source

  // Extracts any exports
  const params = []
  source = source
    .split('\n')
    .map(deMinifyExport)
    .join('\n')
    .split('\n')
    .filter((line) => line.length > 0)
    .filter((line, idx) => {
      if (~line.indexOf('--export')) {
        // Check for normal exports
        let matchedExportComment = line.match(regexPlainExportCommentWithVariable)

        // Handles common exports
        if (matchedExportComment) {
          // Ignores locals
          if (0 == matchedExportComment[0].trim().indexOf('local ')) {
            // Strips out the local keyword
            const lineWithoutLocal = matchedExportComment[0]
              .split(' ')
              .slice(1)
              .join(' ')

            // Re-runs regex
            matchedExportComment = lineWithoutLocal.match(regexPlainExportCommentWithVariable)
          }

          // Adds export
          params.push({
            raw: matchedExportComment[0],
            varName: matchedExportComment[1],
            varDefault: matchedExportComment[2],
            varComment: matchedExportComment[3],
          })
          return false
        }
      }

      // All good
      return true
    })
    .join('\n')

  // Escapes any existing "@", "%", "[[", "]]" on the body
  source = source
    .replace(/\@/g, '@@')
    .replace(/\%/g, '%%')
    .replace(/\[\[/g, '[@[')
    .replace(/\]\]/g, ']@]')

  // Raw statements
  const rawStatements = source
    // New lines, tabs, etc
    .replace(/[\n\r\t]/g, ' ')
    
    // Functions, arrays, etc
    .replace(/([\(\)\[\]])/g, ' $1 ')

    // Actual split
    .split(' ')

  // Combines strings
  const statements = []
  const regexString = /(?<!\\)[\'\"]/g
  let accumulator = null
  for (let iStatement = 0; iStatement < rawStatements.length; iStatement++) {
    const statement = rawStatements[iStatement]
    const stringOpenersAndClosers = (regexString.exec(statement) || []).length;

    // Handles accumulator
    if (accumulator) {
      accumulator += ' ' + statement
    }
    
    // Handles opening and closing of strings, so we combine them
    if (stringOpenersAndClosers % 2 == 1) {
      if (accumulator) {
        // Resets accumulator, if it exists
        statements.push(accumulator)
        accumulator = null
      } else {
        // Starts accumulator
        accumulator = statement
      }
    }

    // If no accumulator is open, add the current string
    else if (!accumulator) {
      statements.push(statement)
    }
  }

  // Adds last statement, if any
  if (accumulator) {
    statements.push(accumulator)
  }

  // Gets most used statements
  const statementCounts = statements
    .map((statement) => statement.trim())
    .reduce((all, statement) => {
      all[statement] = (all[statement] || 0) + 1
      return all
    }, { })

  // Sorts values that might be most efficiently compressed, based on their length and how many times they repeat
  const mostUsedStatements = Object.keys(statementCounts).sort((a, b) => {
    if (a.length * statementCounts[a] > b.length * statementCounts[b]) return 1
    if (b.length * statementCounts[b] > a.length * statementCounts[a]) return -1
    return 0
  }).reverse()

  // Converts to index
  const indexable = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    'A', 'B', 'C', 'D', 'E', 'F',
    // 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
    // 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  ]
  const maxIndexables = 2
  const maxIndexableValue = Math.pow(indexable.length, maxIndexables)
  const convertToIndex = function (value) {
    let right = value % indexable.length
    let left = (value - (value % indexable.length)) / indexable.length
    return `${ indexable[left] }${ indexable[right] }`
  }

  // Selects only meaningful statements
  const bestStatements = mostUsedStatements
    .filter((statement) => statementCounts[statement] > 1)
    .filter((statement) => statement.length > maxIndexables + 1)
    .slice(0, maxIndexableValue)
    .map((statement, idx) => [statement, convertToIndex(idx)])

  // Gets size before compression
  const sourceSize = Buffer.byteLength(source, 'utf8')

  // Replaces the statements
  bestStatements.forEach((statement) => {
    // Prepares safe regex
    const escapedStatement = statement[0].replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&')

    // Does replace
    source = source.replace(new RegExp(escapedStatement, 'g'), () => `@${ statement[1] }`)
  })

  // Create a Lua table maping these statements
  const statementTable = bestStatements
    .map((statement) => `_${ statement[1] }='${ statement[0].replace(/\'/g, () => '\\\'') }'`)
    .join(',')

  // Now we write the Lua to inflate stuff back
  const inflateLua = runMinifier(helperCompressed)
      .replace('__SYMBOLS__', () => statementTable)
      .replace('__SOURCE__', () => `\n${ source }\n`)
      .replace('__PARAMS__()', () => `\n${ params.map((param) => param.raw).join('\n') }\n`)

  // Informs compression stuff
  const finalSize = Buffer.byteLength(inflateLua, 'utf8')
  if (finalSize < sourceSize) {
    CLI.info('REDUCER', `Input size: ${ prettyPrintSize(sourceSize) }`)
    CLI.info('REDUCER', `Final size: ${ prettyPrintSize(finalSize) }`)
    CLI.info('REDUCER', `Total savings: ${ prettyPrintSize(sourceSize - finalSize) } (Ratio: ${ (100 * finalSize / sourceSize).toFixed(2) }%)`)
    return inflateLua
  } else {
    CLI.info('REDUCER', `Compression had no effective result, skipping...`)
    return initialLua
  }
}

function makeMain(source, minify, compress) {
  // Minification
  source = minify ? runMinifier(source) : source

  // Compression
  source = compress ? runCompression(source) : source

  // Done
  return source
}

function makeEmptySlotList() {
  const slots = []
  for (let i = 0; i < 21; i++) {
    slots.push({ name: `slot${ i }` })
  }
  return slots
}

function makeSlotDefinition(name, type) {
  const def = {
    name,
    type: {
      methods: [],
      events: [],
    },
  }

  if (type) def._elementType = type

  return def
}

function makeRunOnce(name, code) {
  return `if not __${ name } then\n${ code }\n__${ name }=true\nend`
}

let slotHandlerCount = 0
function makeSlotHandler(autoconf, slot, signature, code) {
  const regexArgs = /(.*?)\((.*?)\)/g
  const regexMatches = regexArgs.exec(signature)
  const call = (regexMatches[1] || '').split(',')
  const args = (regexMatches[2] || '').split(',')
  const argsN = args.length

  // If no code is found, generate the trigger event one
  if (!code) {
    const slotName = autoconf.slots[slot].name
    const callArgs = [
      `"${ call }"`,
      ...args
    ]
    code = `${ slotName }:triggerEvent(${ callArgs.map(arg => arg.trim()).filter(arg => arg.length > 0).join(',') })`
  }

  // Cleanup code
  const cleanCode = deMinifyExport(code)
    .replace(/\r/g, '') // Remove carriage returns

  // The proper event handler
  return {
    key: parseInt(slotHandlerCount++),
    filter: {
      slotKey: parseInt(slot),
      signature,
      args: makeSlotHandlerArgs(argsN),
    },
    code: cleanCode,
  }
}

function makeSlotHandlerArgs(argsN) {
  const args = []
  while (argsN-- > 0) {
    args.push({ variable: '*' })
  }
  return args
}

module.exports = function buildJsonOrYaml (project, build, source, preloads, minify) {
  // Base structure
  const autoconf = {
    slots: {},
    handlers: [],
    methods: [],
    events: [],
  }

  // Setup slots
  autoconf.slots[internalTypes.library.slotId] = makeSlotDefinition('library', 'library')
  autoconf.slots[internalTypes.system.slotId] = makeSlotDefinition('system', 'system')
  autoconf.slots[internalTypes.control.slotId] = makeSlotDefinition('unit', 'control')

  // How many slots to offset
  const slotOffset = Object.keys(autoconf.slots).length

  // Makes internals always be minified (disable for compiler debugging!)
  const minifyCompilerInternals = true

  // Informative lines
  if (build.noHelpers) CLI.info('BUILDER', `Build '${build.name}' will not include compiler internals.`)
  if (build.noEvents) CLI.info('BUILDER', `Build '${build.name}' will not include event handlers.`)

  // Compiler internals
  if (!build.noHelpers) {
    autoconf.handlers.push(
      makeSlotHandler(autoconf, -3, 'start()', [
        // Injects event-handling helper
        minifyCompilerInternals ? runMinifier(helperEvents) : helperEvents,

        // Injects autoconfig helper
        minifyCompilerInternals ? runMinifier(helperLinking) : helperLinking,
      ].join('\n'))
    )
  }

  // External libraries go directly to the library slot
  preloads.forEach((preload) => {
    autoconf.handlers.push(
      makeSlotHandler(autoconf, -3, 'start()', minify ? minifier(preload.source) : preload.source)
    )
  })

  // console.log(autoconf.handlers)

  // Slot event handlers
  const slotEvents = []

  // Generates a list of slots from the build
  const buildSlots = Object.values(build.slots)

  // Generates a list of empty slots we'll override later
  const baseSlots = makeEmptySlotList().map((_, idx) => {
    if (buildSlots[idx]) {
      const slot = buildSlots[idx]

      // Checks if the slot is valid
      if (slot.name) {
        return slot
      }
      
      // Warns and ignores invalid slots
      CLI.warn(`Invalid slot: missing attribute "${ 'name'.magenta }"`)
    }

    // Keeps base slot if nothing happens
    return _
  })

  // Adds internal events
  if (!build.noEvents) {
    Object.keys(internalTypes).forEach((type) => {
      const typeInfo = internalTypes[type]
      if (typeInfo.events) {
        slotEvents.push(autoconf.slots[typeInfo.slotId].name)
        typeInfo.events.forEach((event) => {
          autoconf.handlers.push(
            makeSlotHandler(autoconf, typeInfo.slotId, event.signature)
          )
        })
      }
    })
  }

  // Support different types of slots
  const slotIndexes = {
    general: 0,
    weapon: 10,
    pvpRadar: 20,
  }

  // Setup slots and event handlers
  baseSlots.forEach((slot) => {
    // Computes the new slot ID
    let slotId = (() => {
      switch (slot.type) {
        case 'weapon':
          return slotIndexes.weapon++
        case 'pvpRadar':
          return slotIndexes.pvpRadar
        default:
          return slotIndexes.general++
      }
      Object.keys(autoconf.slots).length - slotOffset
    })()

    // If slot is already filled, skips to next
    let existingData = autoconf.slots[slotId]
    while (existingData && existingData.type) {
      slotId++
      existingData = autoconf.slots[slotId]
    }

    // Skips slots past limit
    if (slotId > baseSlots.length) return

    // For proper slots with types
    if (slot.type && elementTypes[slot.type]) {
      // Gets the proper slot type
      const slotType = elementTypes[slot.type]

      // Creates the slot
      autoconf.slots[slotId] = makeSlotDefinition(slot.name, slotType.value)

      // Sets autoconfig slot class whenever select ("all" or "manual") is set
      const slotClass = elementTypes[slot.type] && elementTypes[slot.type].class;
      if (slot.select && slotClass) {
        autoconf.slots[slotId].class = slotClass;
        autoconf.slots[slotId].select = slot.select;
      }

      // Optionally creates events
      if (!build.noEvents && slotType.events) {
        // Enables event handling automatically for that slot
        slotEvents.push(slot.name)
          
        // Processes each available event
        slotType.events.forEach((event) => {
          autoconf.handlers.push(
            makeSlotHandler(autoconf, slotId, event.signature)
          )
        })
      }
    } else {
      // Generic elements
      autoconf.slots[slotId] = makeSlotDefinition(slot.name, slot.type || null)
    }
  })

  // Adds event handler set-up code
  if (!build.noEvents && slotEvents.length > 0) {
    autoconf.handlers.push(
      makeSlotHandler(autoconf, -3, 'start()', `-- Setup improved event handlers\n${ makeRunOnce('EVENTS', slotEvents.map(slot => `library.addEventHandlers(${ slot })`).join('\n')) }`)
    )
  }

  // Runs minification
  const resultMain = makeMain(source, minify, !!build.compress)

  // Adds the main code to the unit's start
  autoconf.handlers.push(
    makeSlotHandler(autoconf, -1, 'start()', resultMain)
  )

  return autoconf
}