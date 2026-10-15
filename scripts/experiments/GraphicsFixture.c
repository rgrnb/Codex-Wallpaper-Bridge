#define COBJMACROS
#define UNICODE
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <wchar.h>
// Controlled, silent D3D11 source. No file/network/audio APIs.
int WINAPI wWinMain(HINSTANCE module,HINSTANCE previous,LPWSTR arguments,int show) {
 WNDCLASSW cls={0};cls.lpfnWndProc=DefWindowProcW;cls.hInstance=module;cls.lpszClassName=L"CodexBridgeGraphicsFixture";
 RegisterClassW(&cls);HWND hwnd=CreateWindowExW(0,cls.lpszClassName,L"CWB graphics fixture",WS_POPUP|WS_VISIBLE,-10000,-10000,640,360,NULL,NULL,module,NULL);
 BOOL blt=wcsstr(arguments,L"--blt")!=NULL;
 DXGI_SWAP_CHAIN_DESC desc={0};desc.BufferCount=blt?1:2;desc.BufferDesc.Width=640;desc.BufferDesc.Height=360;desc.BufferDesc.Format=wcsstr(arguments,L"--float")?DXGI_FORMAT_R16G16B16A16_FLOAT:DXGI_FORMAT_B8G8R8A8_UNORM;
 desc.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;desc.SampleDesc.Count=1;desc.OutputWindow=hwnd;desc.Windowed=TRUE;desc.SwapEffect=blt?DXGI_SWAP_EFFECT_DISCARD:DXGI_SWAP_EFFECT_FLIP_DISCARD;
 IDXGISwapChain* swap=NULL;ID3D11Device* device=NULL;ID3D11DeviceContext* context=NULL;
 if(FAILED(D3D11CreateDeviceAndSwapChain(NULL,D3D_DRIVER_TYPE_HARDWARE,NULL,0,NULL,0,D3D11_SDK_VERSION,&desc,&swap,&device,NULL,&context)))return 1;
 ID3D11Texture2D* back=NULL;ID3D11RenderTargetView* target=NULL;
 IDXGISwapChain_GetBuffer(swap,0,&IID_ID3D11Texture2D,(void**)&back);ID3D11Device_CreateRenderTargetView(device,(ID3D11Resource*)back,NULL,&target);ID3D11Texture2D_Release(back);
 MSG msg;UINT frame=0;
 while(IsWindow(hwnd)) {
  while(PeekMessageW(&msg,NULL,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessageW(&msg);}
  FLOAT color[4]={0.1f+(frame++%100)/125.0f,0.2f,0.5f,1.0f};
  ID3D11DeviceContext_ClearRenderTargetView(context,target,color);IDXGISwapChain_Present(swap,0,0);Sleep(30);
 }
 ID3D11RenderTargetView_Release(target);ID3D11DeviceContext_Release(context);ID3D11Device_Release(device);IDXGISwapChain_Release(swap);return 0;
}
