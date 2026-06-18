#include <wbemidl.h>
#include <winsock2.h>
#include <iphlpapi.h>
#include <stdio.h>
#include <comdef.h>
#include <iostream>
#include <vector>
#include <string>

#pragma comment(lib, "wbemuuid.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")

struct ThermalData {
    std::string name;
    double value;
    std::string parent;
};

int main() {
    HRESULT hres = CoInitializeEx(0, COINIT_MULTITHREADED);
    if (FAILED(hres)) {
        printf("{\"error\": \"CoInitializeEx failed\"}\n");
        return 1;
    }

    hres = CoInitializeSecurity(NULL, -1, NULL, NULL, RPC_C_AUTHN_LEVEL_DEFAULT,
                                RPC_C_IMP_LEVEL_IMPERSONATE, NULL, EOAC_NONE, NULL);
    if (FAILED(hres)) {
        printf("{\"error\": \"CoInitializeSecurity failed\"}\n");
        CoUninitialize();
        return 1;
    }

    IWbemLocator *pLoc = NULL;
    hres = CoCreateInstance(CLSID_WbemLocator, 0, CLSCTX_INPROC_SERVER,
                            IID_IWbemLocator, (LPVOID *)&pLoc);
    if (FAILED(hres)) {
        printf("{\"error\": \"CoCreateInstance failed\"}\n");
        CoUninitialize();
        return 1;
    }

    IWbemServices *pSvc = NULL;
    hres = pLoc->ConnectServer(
        _bstr_t(L"root\\LibreHardwareMonitor"),
        NULL, NULL, 0, NULL, 0, 0, &pSvc);

    // Fallback to root\HWiNFO64 if LibreHardwareMonitor fails
    if (FAILED(hres)) {
        hres = pLoc->ConnectServer(
            _bstr_t(L"root\\HWiNFO64"),
            NULL, NULL, 0, NULL, 0, 0, &pSvc);
    }

    if (FAILED(hres)) {
        printf("{\"error\": \"ConnectServer failed\"}\n");
        pLoc->Release();
        CoUninitialize();
        return 1;
    }

    hres = CoSetProxyBlanket(pSvc, RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, NULL,
                             RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE,
                             NULL, EOAC_NONE);
    if (FAILED(hres)) {
        printf("{\"error\": \"CoSetProxyBlanket failed\"}\n");
        pSvc->Release();
        pLoc->Release();
        CoUninitialize();
        return 1;
    }

    IEnumWbemClassObject *pEnumerator = NULL;
    hres = pSvc->ExecQuery(
        _bstr_t(L"WQL"),
        _bstr_t(L"SELECT Name, Value, Parent, SensorType FROM Sensor "
                 L"WHERE SensorType='Temperature'"),
        WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY, NULL,
        &pEnumerator);

    if (FAILED(hres)) {
        printf("{\"error\": \"ExecQuery failed\"}\n");
        pSvc->Release();
        pLoc->Release();
        CoUninitialize();
        return 1;
    }

    printf("[");
    bool first = true;

    IWbemClassObject *pclsObj = NULL;
    ULONG uReturn = 0;

    while (pEnumerator) {
        hres = pEnumerator->Next(WBEM_INFINITE, 1, &pclsObj, &uReturn);

        if (0 == uReturn) break;

        VARIANT vtProp;

        // Get Name
        VariantInit(&vtProp);
        pclsObj->Get(L"Name", 0, &vtProp, 0, 0);
        std::string name = (vtProp.vt != VT_NULL) ? _com_util::ConvertBSTRToString(vtProp.bstrVal) : "Unknown";
        VariantClear(&vtProp);

        // Get Value
        VariantInit(&vtProp);
        pclsObj->Get(L"Value", 0, &vtProp, 0, 0);
        double value = (vtProp.vt == VT_R8) ? vtProp.dblVal : 0.0;
        VariantClear(&vtProp);

        // Get Parent
        VariantInit(&vtProp);
        pclsObj->Get(L"Parent", 0, &vtProp, 0, 0);
        std::string parent = (vtProp.vt != VT_NULL) ? _com_util::ConvertBSTRToString(vtProp.bstrVal) : "Unknown";
        VariantClear(&vtProp);

        if (!first) printf(",");
        printf("{\"name\":\"%s\",\"value\":%.1f,\"parent\":\"%s\"}", name.c_str(), value, parent.c_str());
        first = false;

        pclsObj->Release();
    }

    printf("]\n");

    pEnumerator->Release();
    pSvc->Release();
    pLoc->Release();
    CoUninitialize();

    return 0;
}
