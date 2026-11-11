"""AgentCore WebSocket endpoint for the existing vehicle executor.

The trusted Node backend owns vehicle state and returns tool results over the
same session. Do not expose this protocol directly to unauthenticated clients.
"""
import asyncio
import json
import os
import uuid
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import tool
from strands.bidi import BidiAgent
from strands.bidi.models import BedrockNovaSonicModel
from starlette.websockets import WebSocketDisconnect

app = BedrockAgentCoreApp()
MAX_TEXT = 32000

@app.websocket
async def websocket_handler(websocket, context):
    await websocket.accept()
    pending = {}
    send_lock = asyncio.Lock()
    agent = None

    async def send(payload):
        async with send_lock:
            await websocket.send_json(payload)

    async def invoke(name, arguments):
        request_id = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        pending[request_id] = future
        try:
            await send({'type': 'tool_call', 'id': request_id, 'name': name, 'arguments': arguments})
            return await asyncio.wait_for(future, timeout=35)
        finally:
            pending.pop(request_id, None)

    try:
        init = await asyncio.wait_for(websocket.receive_json(), timeout=10)
        if init.get('type') != 'init' or not isinstance(init.get('prompt'), str) or len(init['prompt']) > MAX_TEXT:
            raise ValueError('Invalid initial configuration')
        specs = init.get('tools', [])
        if not isinstance(specs, list) or len(specs) > 2:
            raise ValueError('Invalid tool definitions')
        registered = []
        async def vehicle_callback(actions: list[dict]):
            return await invoke('vehicle_control', {'actions': actions})
        async def assistant_callback(operation: str, query: str, latitude: float | None = None,
                                     longitude: float | None = None, language: str | None = None):
            args = {'operation': operation, 'query': query, 'latitude': latitude,
                    'longitude': longitude, 'language': language}
            return await invoke('assistant_tool', {key: value for key, value in args.items() if value is not None})
        for spec in specs:
            name = spec['name']
            if name not in ('vehicle_control', 'assistant_tool'):
                raise ValueError('Unrecognized tool')
            registered.append(tool(name=name, description=spec['description'], inputSchema={'json': spec['schema']})(vehicle_callback if name == 'vehicle_control' else assistant_callback))
        model = BedrockNovaSonicModel(
            model_id=os.getenv('SONIC_MODEL', 'amazon.nova-2-5-sonic'),
            region=os.getenv('SONIC_REGION', 'ap-northeast-1'),
            voice='tiffany',
            audio={'input': {'sample_rate': 16000}, 'output': {'sample_rate': 24000}},
            params={'inferenceConfiguration': {'maxTokens': 1024, 'topP': 0.9, 'temperature': 0.3},
                    'turnDetectionConfiguration': {'endpointingSensitivity': 'LOW'}},
        )
        agent = BidiAgent(model=model, tools=registered, system_prompt=init['prompt'])
        async with agent:
            await send({'type': 'ready'})
            async def receive_inputs():
                while True:
                    message = await websocket.receive()
                    if message.get('type') == 'websocket.disconnect':
                        break
                    if message.get('bytes') is not None:
                        data = message['bytes']
                        if len(data) > 6400 or len(data) % 2:
                            raise ValueError('Invalid PCM frame')
                        await agent.send({'audio_delta': {'format': 'pcm', 'source': {'bytes': data}}})
                    elif message.get('text') is not None:
                        payload = json.loads(message['text'])
                        if payload.get('type') == 'text' and isinstance(payload.get('text'), str) and len(payload['text']) <= 500:
                            await agent.send(payload['text'])
                        elif payload.get('type') == 'tool_result':
                            future = pending.get(payload.get('id'))
                            if future and not future.done():
                                future.set_result(payload.get('result'))
                        elif payload.get('type') == 'stop':
                            break
                        else:
                            raise ValueError('Invalid input')
            async def send_outputs():
                async for event in agent.receive():
                    if isinstance(event, dict) and str(event.get('type', '')).startswith('bidi_'):
                        await send({'type': 'event', 'event': event})
            tasks = [asyncio.create_task(receive_inputs()), asyncio.create_task(send_outputs())]
            done, waiting = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in waiting:
                task.cancel()
            await asyncio.gather(*waiting, return_exceptions=True)
            for task in done:
                task.result()
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except Exception as exc:
        try:
            await send({'type': 'error', 'error': str(exc)[:500]})
        except Exception:
            pass
    finally:
        for future in pending.values():
            if not future.done():
                future.cancel()

if __name__ == '__main__':
    app.run(port=int(os.getenv('PORT', '8080')), host=os.getenv('HOST', '127.0.0.1'))
