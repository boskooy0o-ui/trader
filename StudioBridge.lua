local Http = game:GetService("HttpService")
local Log = game:GetService("LogService")
local Run = game:GetService("RunService")
local CH = game:GetService("ChangeHistoryService")

if not Run:IsEdit() then return end

local BASE = "http://localhost:8765"
local CLASSES = { Script = true, LocalScript = true, ModuleScript = true }

local toolbar = plugin:CreateToolbar("Ollama Studio")
local logBtn = toolbar:CreateButton("Log", "Show Ollama bridge log", "")
local pauseBtn = toolbar:CreateButton("Pause", "Pause or resume the bridge", "")
logBtn.ClickableWhenViewportHidden = true
pauseBtn.ClickableWhenViewportHidden = true

local widget = plugin:CreateDockWidgetPluginGui(
	"OllamaBridge",
	DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, false, 360, 240, 240, 120)
)
widget.Title = "Ollama Bridge"
local scroll = Instance.new("ScrollingFrame")
scroll.Size = UDim2.fromScale(1, 1)
scroll.BackgroundColor3 = Color3.fromRGB(24, 26, 34)
scroll.BorderSizePixel = 0
scroll.AutomaticCanvasSize = Enum.AutomaticSize.Y
scroll.CanvasSize = UDim2.new()
scroll.ScrollBarThickness = 6
scroll.Parent = widget
local label = Instance.new("TextLabel")
label.Size = UDim2.new(1, -8, 0, 0)
label.Position = UDim2.fromOffset(4, 4)
label.AutomaticSize = Enum.AutomaticSize.Y
label.BackgroundTransparency = 1
label.TextColor3 = Color3.fromRGB(210, 216, 245)
label.Font = Enum.Font.Code
label.TextSize = 13
label.TextWrapped = true
label.TextXAlignment = Enum.TextXAlignment.Left
label.TextYAlignment = Enum.TextYAlignment.Top
label.Parent = scroll

local lines, lastMsg = {}, ""
local function say(msg)
	if msg == lastMsg then return end
	lastMsg = msg
	table.insert(lines, os.date("%H:%M:%S") .. "  " .. msg)
	if #lines > 80 then table.remove(lines, 1) end
	label.Text = table.concat(lines, "\n")
	scroll.CanvasPosition = Vector2.new(0, 1e6)
end

local paused = false
logBtn.Click:Connect(function() widget.Enabled = not widget.Enabled end)
pauseBtn.Click:Connect(function()
	paused = not paused
	pauseBtn:SetActive(paused)
	say(paused and "paused" or "resumed")
end)

local capture = nil
Log.MessageOut:Connect(function(msg, kind)
	if capture and kind == Enum.MessageType.MessageError then
		table.insert(capture, msg)
	end
end)

local function locate(path, create)
	local parts = string.split(path, "/")
	local ok, cur = pcall(game.GetService, game, parts[1])
	if not ok then error("unknown service: " .. parts[1], 0) end
	for i = 2, #parts do
		local nxt = cur:FindFirstChild(parts[i])
		if not nxt then
			if not create then return nil end
			nxt = Instance.new("Folder")
			nxt.Name = parts[i]
			nxt.Parent = cur
		end
		cur = nxt
	end
	return cur
end

local function validName(n)
	return type(n) == "string" and n:match("^[%w_ ]+$") ~= nil and #n <= 50
end

local function waitIdle()
	while Run:IsRunning() do task.wait(0.5) end
end

local handlers = {}

function handlers.ping()
	return "pong"
end

function handlers.write(c)
	if not CLASSES[c.class] then error("bad class: " .. tostring(c.class), 0) end
	if not validName(c.name) then error("bad name: " .. tostring(c.name), 0) end
	if type(c.source) ~= "string" or c.source == "" then error("empty source", 0) end
	waitIdle()
	local rec = CH:TryBeginRecording("Ollama: " .. c.name)
	local ok, err = pcall(function()
		local parent = locate(c.path, true)
		local s = parent:FindFirstChild(c.name)
		if s and s.ClassName ~= c.class then
			s:Destroy()
			s = nil
		end
		if not s then
			s = Instance.new(c.class)
			s.Name = c.name
			s.Parent = parent
		end
		s.Source = c.source
	end)
	if rec then CH:FinishRecording(rec, ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel) end
	if not ok then error(err, 0) end
	say("wrote " .. c.path .. "/" .. c.name)
	return "written " .. c.path .. "/" .. c.name
end

function handlers.read(c)
	local parent = locate(c.path, false)
	local s = parent and parent:FindFirstChild(c.name)
	if not s or not s:IsA("LuaSourceContainer") then error("script not found", 0) end
	return s.Source
end

function handlers.delete(c)
	local parent = locate(c.path, false)
	local s = parent and parent:FindFirstChild(c.name)
	if not s then error("script not found", 0) end
	s:Destroy()
	say("deleted " .. c.path .. "/" .. c.name)
	return "deleted"
end

function handlers.playtest(c)
	waitIdle()
	local limit = math.clamp(tonumber(c.seconds) or 8, 2, 60)
	capture = {}
	local ok, err = pcall(Run.Run, Run)
	if not ok then
		capture = nil
		error("cannot start run mode: " .. tostring(err), 0)
	end
	say("playtest " .. limit .. "s")
	local t0 = os.clock()
	while os.clock() - t0 < limit and Run:IsRunning() do task.wait(0.25) end
	if Run:IsRunning() then pcall(Run.Stop, Run) end
	task.wait(1.5)
	local seen, out = {}, {}
	for _, m in ipairs(capture) do
		if not seen[m] then
			seen[m] = true
			table.insert(out, m)
		end
	end
	capture = nil
	local text = table.concat(out, "\n")
	if #text > 1500 then text = text:sub(1, 1500) end
	say(#out == 0 and "playtest clean" or ("playtest: " .. #out .. " error(s)"))
	return text
end

local function request(method, path, body)
	return Http:RequestAsync({
		Url = BASE .. path,
		Method = method,
		Headers = body and { ["Content-Type"] = "application/json" } or nil,
		Body = body,
	})
end

local function execute(c)
	local h = handlers[c.type]
	local ok, out
	if h then
		ok, out = pcall(h, c)
	else
		ok, out = false, "unknown command: " .. tostring(c.type)
	end
	if not ok then say("error: " .. tostring(out)) end
	local posted, perr = pcall(request, "POST", "/plugin/result", Http:JSONEncode({ id = c.id, ok = ok, output = tostring(out) }))
	if not posted then say("could not send result: " .. tostring(perr)) end
end

task.spawn(function()
	local connected, delay = false, 1
	while true do
		if paused then
			task.wait(1)
			continue
		end
		local ok, res = pcall(request, "GET", "/plugin/poll")
		if ok and res.Success then
			if not connected then
				connected = true
				say("connected to " .. BASE)
			end
			delay = 1
			local okj, c = pcall(Http.JSONDecode, Http, res.Body)
			if okj and type(c) == "table" and c.type then execute(c) end
		else
			connected = false
			local why = ok and tostring(res.StatusCode) or tostring(res)
			if why:find("not enabled") or why:find("not allowed") then
				why = why .. " (allow HTTP requests for this plugin)"
			end
			say("server unreachable: " .. why)
			task.wait(delay)
			delay = math.min(delay * 2, 10)
		end
	end
end)

say("bridge started")
