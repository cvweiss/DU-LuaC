-- Error handler
local function handleError (source, err)
  local iLine, iMsg = err:find('%d+:%s')
  if iLine then
    local line, msg, lineNumber = tonumber(err:sub(iLine, iMsg - 2)), err:sub(iMsg), 0
    for lineSource in source:gmatch('[^\r\n]+') do
      lineNumber = lineNumber + 1
      if lineNumber == line then
        system.print(string.format('[ERROR] %s near `%s`', msg, lineSource))
        break
      end
    end
  else
    system.print('[ERROR] ' .. err)
  end
end

-- Exported variables
__PARAMS__()

-- Those values will be filled by the compiler
local symbols = {__SYMBOLS__}
local source = [[__SOURCE__]]
-- Processes symbol table (main expand happens here)
for ref, value in pairs(symbols) do
  source = source:gsub('@' .. ref:sub(2), value)
end

-- De-escapes values from compiler, removes comments too
source = source:gsub('%[@%[', '[[')
source = source:gsub('%]@%]', ']]')
source = source:gsub('@@', '@')
source = source:gsub('%%%%', '%%')
source = source:gsub('%-%-.-\n', '')
source = source:gsub('%)', ')\n')

-- Passes down env and links
local env = { system = system, library = library, unit = unit }
for k, v in pairs(_G) do
  env[k] = v
end
for k, v in pairs(unit) do
  if 'table' == type(v) and 'function' == type(v.getElementClass) then
    env[k] = v
  end
end

-- Runs the Lua code
local loaded, err = load(source, nil, 't', env)
if loaded then
  xpcall(loaded, function (err)
    handleError(source, err)
  end)
else
  handleError(source, err)
end

-- Updates current environment with the new globals
for k, v in pairs(env) do
  _G[k] = v
end